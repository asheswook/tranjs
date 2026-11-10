import * as mysql2 from "mysql2/promise";
import { createConnection } from "mysql2";
import {
    getTransactionManager,
    InvalidIsolationLevelError,
    IsolationLevel,
    Logger,
    MetadataWrappedTransaction,
    PlatformTransactionManager,
    TransactionContextMixingError,
    TransactionOptions,
    useTransactionManager,
} from "@tranjs/core";
import { PoolConnection } from "./context";
import { UnsupportedIsolationLevelError } from "./error";
import type { FixtureLease } from "@tranjs/core/internal/testing-bridge";
import { createMysql2FixtureConnection } from "./fixture";
import type { Mysql2FixtureConnection } from "./fixture";

const DRIVER_NAME = Symbol("mysql2");

export function useMySQLTransactionManager(pool: mysql2.Pool, name?: string | symbol) {
    const manager = new MySQLTransactionManager(pool);
    useTransactionManager(manager, name);
}

export interface MySQLConnectionPerTransactionOptions {
    /** Defaults to reject: Hyperdrive silently ignores MySQL isolation settings. */
    isolationLevelSupport?: "apply" | "reject";
}

/** Register once at startup/module scope; config is resolved for each physical transaction. */
export function useMySQLConnectionPerTransaction(
    config: mysql2.ConnectionOptions | (() => mysql2.ConnectionOptions | Promise<mysql2.ConnectionOptions>),
    name?: string | symbol,
    options?: MySQLConnectionPerTransactionOptions,
) {
    useTransactionManager(new MySQLConnectionPerTransactionManager(config, options), name);
}

/** Get this datasource's active MySQL transaction. */
export const ctx = (datasource?: string | symbol): PoolConnection => {
    const manager = getTransactionManager(datasource);
    if (!(manager instanceof MySQLTransactionManager) && !(manager instanceof MySQLConnectionPerTransactionManager)) {
        throw new TransactionContextMixingError(manager.constructor.name, DRIVER_NAME);
    }
    const transaction = manager.getCurrentTransaction();
    if (!transaction) throw new Error("Transaction context not initialized");
    return manager.wrapConnection(transaction);
};

abstract class MySQLManagerBase extends PlatformTransactionManager<PoolConnection> {
    private readonly wrappers = new WeakMap<PoolConnection, PoolConnection>();

    protected createFixtureConnection(tx: PoolConnection, lease: FixtureLease): Mysql2FixtureConnection {
        return createMysql2FixtureConnection(tx, lease);
    }

    public checkDeadline(): number | undefined { return this.getRemainingTimeout(); }

    public wrapConnection(connection: PoolConnection): PoolConnection {
        let wrapper = this.wrappers.get(connection);
        if (wrapper) return wrapper;
        wrapper = new Proxy(connection, {
            get: (target, property) => {
                const value = Reflect.get(target, property, target);
                if (property !== "query" && property !== "execute") {
                    return typeof value === "function" ? value.bind(target) : value;
                }
                return (...args: any[]) => {
                    const remaining = this.checkDeadline();
                    if (remaining === undefined) return value.apply(target, args);
                    const config = typeof args[0] === "string" ? { sql: args[0] } : args[0];
                    args[0] = { ...config, timeout: remaining };
                    return value.apply(target, args).catch((error: any) => {
                        if (error?.code === "PROTOCOL_SEQUENCE_TIMEOUT") {
                            throw this.expireTransaction() ?? error;
                        }
                        throw error;
                    });
                };
            },
        });
        this.wrappers.set(connection, wrapper);
        return wrapper;
    }

    protected async commitTransaction(tx: PoolConnection): Promise<void> {
        await (tx as unknown as mysql2.Connection).commit();
    }

    protected async rollbackTransaction(tx: PoolConnection): Promise<void> {
        await (tx as unknown as mysql2.Connection).rollback();
    }

    protected async createSavepoint(tx: PoolConnection, name: string): Promise<void> {
        await tx.query(`SAVEPOINT ${name}`);
    }

    protected async rollbackToSavepoint(tx: PoolConnection, name: string): Promise<void> {
        await tx.query(`ROLLBACK TO SAVEPOINT ${name}`);
    }

    protected async releaseSavepoint(tx: PoolConnection, name: string): Promise<void> {
        await tx.query(`RELEASE SAVEPOINT ${name}`);
    }
}

export class MySQLTransactionManager extends MySQLManagerBase {
    constructor(private readonly pool: mysql2.Pool) {
        super();
    }

    protected async beginTransaction(options?: TransactionOptions): Promise<MetadataWrappedTransaction<PoolConnection>> {
        if (options?.isolationLevel !== undefined && !Object.values(IsolationLevel).includes(options.isolationLevel)) {
            throw new InvalidIsolationLevelError(options.isolationLevel);
        }
        const connection = await this.pool.getConnection();
        try {
            if (options?.isolationLevel) {
                await connection.query(`SET TRANSACTION ISOLATION LEVEL ${options.isolationLevel}`);
            }
            await connection.query(`START TRANSACTION${options?.readOnly ? " READ ONLY" : ""}`);
            return { metadata: { driverName: DRIVER_NAME }, transaction: connection };
        } catch (error) {
            let dirty = false;
            try { await connection.rollback(); } catch { dirty = true; }
            if (dirty) connection.destroy();
            else connection.release();
            throw error;
        }
    }

    protected async releaseTransaction(tx: PoolConnection, failed: boolean): Promise<void> {
        const connection = tx as mysql2.PoolConnection;
        if (failed) connection.destroy();
        else connection.release();
    }
}

/** A fresh connection for each physical transaction, suitable for Workers + Hyperdrive. */
export class MySQLConnectionPerTransactionManager extends MySQLManagerBase {
    private readonly ended = new WeakSet<PoolConnection>();
    private cleanupLogger: Logger = console;

    constructor(
        private readonly config: mysql2.ConnectionOptions | (() => mysql2.ConnectionOptions | Promise<mysql2.ConnectionOptions>),
        private readonly options: MySQLConnectionPerTransactionOptions = {},
    ) {
        super();
    }

    public setLogger(logger: Logger): void {
        super.setLogger(logger);
        this.cleanupLogger = logger;
    }

    protected async beginTransaction(options?: TransactionOptions): Promise<MetadataWrappedTransaction<PoolConnection>> {
        if (options?.isolationLevel !== undefined) {
            if (!Object.values(IsolationLevel).includes(options.isolationLevel)) {
                throw new InvalidIsolationLevelError(options.isolationLevel);
            }
            if (this.options.isolationLevelSupport !== "apply") {
                throw new UnsupportedIsolationLevelError(options.isolationLevel);
            }
        }
        const config = typeof this.config === "function" ? await this.config() : this.config;
        // The promise-only createConnection hides its connection if the handshake
        // fails. Keep the handle so even connect failures can be ended once.
        const raw = createConnection(config);
        // mysql2 emits idle socket failures on the underlying connection, not
        // necessarily the promise wrapper. Its fatal-error handling closes the
        // connection and rejects future commands; this listener prevents a crash.
        // Leave it harmless after release to absorb late socket events too.
        raw.on("error", () => {});
        const connection = raw.promise();
        // Preserve the historical ctx() type; runtime connections share the query API.
        const transaction = connection as unknown as PoolConnection;
        try {
            await connection.connect();
        } catch (error) {
            await this.releaseTransaction(transaction, true);
            throw error;
        }
        try {
            if (options?.isolationLevel) {
                await connection.query(`SET TRANSACTION ISOLATION LEVEL ${options.isolationLevel}`);
            }
            await connection.query(`START TRANSACTION${options?.readOnly ? " READ ONLY" : ""}`);
            return { metadata: { driverName: DRIVER_NAME }, transaction };
        } catch (error) {
            // START may have succeeded before the driver reported an error.
            try { await connection.rollback(); } catch {}
            await this.releaseTransaction(transaction, true);
            throw error;
        }
    }

    protected async releaseTransaction(tx: PoolConnection, failed: boolean): Promise<void> {
        if (this.ended.has(tx)) return;
        this.ended.add(tx);
        const connection = tx as unknown as mysql2.Connection;
        // Failed handshakes/dead sockets may leave QUIT queued forever. Close
        // failed connections first, then invoke end exactly once on every path.
        if (failed) { try { connection.destroy(); } catch {} }
        try { await connection.end(); }
        catch (error) {
            // Neither cleanup nor a custom logger may mask the transaction outcome.
            try { this.cleanupLogger.error("MySQL connection cleanup failed", error); } catch {}
        }
    }
}
