import * as pg from "pg";
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
import { PoolClient } from "./context";

const DRIVER_NAME = Symbol("pg");

export function usePostgreSQLTransactionManager(pool: pg.Pool, name?: string | symbol) {
    const manager = new PostgreSQLTransactionManager(pool);
    useTransactionManager(manager, name);
}

/** Register once at startup/module scope; config is resolved for each physical transaction. */
export function usePostgreSQLClientPerTransaction(
    config: pg.ClientConfig | (() => pg.ClientConfig | Promise<pg.ClientConfig>),
    name?: string | symbol,
) {
    useTransactionManager(new PostgreSQLClientPerTransactionManager(config), name);
}

/** Get this datasource's active PostgreSQL transaction. */
export const ctx = (datasource?: string | symbol): PoolClient => {
    const manager = getTransactionManager(datasource);
    if (!(manager instanceof PostgreSQLTransactionManager) && !(manager instanceof PostgreSQLClientPerTransactionManager)) {
        throw new TransactionContextMixingError(manager.constructor.name, DRIVER_NAME);
    }
    const transaction = manager.getCurrentTransaction();
    if (!transaction) throw new Error("Transaction context not initialized");
    return manager.wrapConnection(transaction);
};

abstract class PostgreSQLManagerBase extends PlatformTransactionManager<PoolClient> {
    private readonly wrappers = new WeakMap<PoolClient, PoolClient>();

    public checkDeadline(): number | undefined { return this.getRemainingTimeout(); }

    public wrapConnection(connection: PoolClient): PoolClient {
        let wrapper = this.wrappers.get(connection);
        if (wrapper) return wrapper;
        wrapper = new Proxy(connection, {
            get: (target, property) => {
                const value = Reflect.get(target, property, target);
                if (property !== "query") return typeof value === "function" ? value.bind(target) : value;
                return (...args: any[]) => {
                    const remaining = this.checkDeadline();
                    // Submittables own their event/cursor lifecycle: do not inject pg's read timer
                    // or intercept their callbacks/results. The owner checks the deadline at commit.
                    if (remaining === undefined || typeof args[0]?.submit === "function") return value.apply(target, args);
                    const config = args[0];
                    // pg supports query_timeout at runtime, though QueryConfig's types omit it.
                    args[0] = typeof config === "string" ? { text: config, query_timeout: remaining }
                        : { ...config, query_timeout: remaining };
                    const deadlineError = (error: unknown) => {
                        if (!error) return error;
                        if (error instanceof Error && error.message === "Query read timeout") {
                            return this.expireTransaction() ?? error;
                        }
                        return error;
                    };
                    const last = args.length - 1;
                    if (typeof args[last] === "function") {
                        const callback = args[last];
                        args[last] = (error: unknown, ...results: any[]) => callback(deadlineError(error), ...results);
                    } else if (typeof args[0]?.callback === "function") {
                        const callback = args[0].callback;
                        args[0].callback = (error: unknown, ...results: any[]) => callback(deadlineError(error), ...results);
                    }
                    const result = value.apply(target, args);
                    return result && typeof result.then === "function"
                        ? result.catch((error: unknown) => { throw deadlineError(error); }) : result;
                };
            },
        });
        this.wrappers.set(connection, wrapper);
        return wrapper;
    }

    protected async commitTransaction(tx: PoolClient): Promise<void> {
        await tx.query("COMMIT");
    }

    protected async rollbackTransaction(tx: PoolClient): Promise<void> {
        await tx.query("ROLLBACK");
    }

    protected async createSavepoint(tx: PoolClient, name: string): Promise<void> {
        await tx.query(`SAVEPOINT ${name}`);
    }

    protected async rollbackToSavepoint(tx: PoolClient, name: string): Promise<void> {
        await tx.query(`ROLLBACK TO SAVEPOINT ${name}`);
    }

    protected async releaseSavepoint(tx: PoolClient, name: string): Promise<void> {
        await tx.query(`RELEASE SAVEPOINT ${name}`);
    }
}

export class PostgreSQLTransactionManager extends PostgreSQLManagerBase {
    constructor(private readonly pool: pg.Pool) {
        super();
    }

    protected async beginTransaction(options?: TransactionOptions): Promise<MetadataWrappedTransaction<PoolClient>> {
        if (options?.isolationLevel !== undefined && !Object.values(IsolationLevel).includes(options.isolationLevel)) {
            throw new InvalidIsolationLevelError(options.isolationLevel);
        }
        const connection = await this.pool.connect();
        try {
            let sql = "BEGIN";
            if (options?.isolationLevel) sql += ` ISOLATION LEVEL ${options.isolationLevel}`;
            if (options?.readOnly) sql += " READ ONLY";
            await connection.query(sql);
            return { metadata: { driverName: DRIVER_NAME }, transaction: connection };
        } catch (error) {
            // BEGIN may have succeeded before the driver reported an error.
            let releaseError: Error | undefined;
            try { await connection.query("ROLLBACK"); }
            catch (rollbackError) { releaseError = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)); }
            connection.release(releaseError);
            throw error;
        }
    }

    protected async releaseTransaction(tx: PoolClient, failed: boolean): Promise<void> {
        (tx as pg.PoolClient).release(failed ? new Error("Transaction completion failed") : undefined);
    }
}

/** A fresh Client for each physical transaction, suitable for Workers + Hyperdrive. */
export class PostgreSQLClientPerTransactionManager extends PostgreSQLManagerBase {
    private readonly ended = new WeakSet<PoolClient>();
    private cleanupLogger: Logger = console;

    constructor(private readonly config: pg.ClientConfig | (() => pg.ClientConfig | Promise<pg.ClientConfig>)) {
        super();
    }

    public setLogger(logger: Logger): void {
        super.setLogger(logger);
        this.cleanupLogger = logger;
    }

    protected async beginTransaction(options?: TransactionOptions): Promise<MetadataWrappedTransaction<PoolClient>> {
        if (options?.isolationLevel !== undefined && !Object.values(IsolationLevel).includes(options.isolationLevel)) {
            throw new InvalidIsolationLevelError(options.isolationLevel);
        }
        const config = typeof this.config === "function" ? await this.config() : this.config;
        const client = new pg.Client(config);
        try {
            await client.connect();
        } catch (error) {
            await this.releaseTransaction(client, true);
            throw error;
        }
        try {
            let sql = "BEGIN";
            if (options?.isolationLevel) sql += ` ISOLATION LEVEL ${options.isolationLevel}`;
            if (options?.readOnly) sql += " READ ONLY";
            await client.query(sql);
            return { metadata: { driverName: DRIVER_NAME }, transaction: client };
        } catch (error) {
            // BEGIN may have succeeded before the driver reported an error.
            try { await client.query("ROLLBACK"); } catch {}
            await this.releaseTransaction(client, true);
            throw error;
        }
    }

    protected async releaseTransaction(tx: PoolClient, _failed: boolean): Promise<void> {
        if (this.ended.has(tx)) return;
        this.ended.add(tx);
        try { await tx.end(); }
        catch (error) {
            // Neither cleanup nor a custom logger may mask the transaction outcome.
            try { this.cleanupLogger.error("PostgreSQL client cleanup failed", error); } catch {}
        }
    }
}
