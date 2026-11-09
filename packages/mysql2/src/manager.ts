import * as mysql2 from "mysql2/promise";
import {
    getTransactionManager,
    InvalidIsolationLevelError,
    IsolationLevel,
    MetadataWrappedTransaction,
    PlatformTransactionManager,
    TransactionContextMixingError,
    TransactionOptions,
    useTransactionManager,
} from "@tranjs/core";
import { PoolConnection } from "./context";

const DRIVER_NAME = Symbol("mysql2");

export function useMySQLTransactionManager(pool: mysql2.Pool, name?: string | symbol) {
    const manager = new MySQLTransactionManager(pool);
    useTransactionManager(manager, name);
}

/** Get this datasource's active MySQL transaction. */
export const ctx = (datasource?: string | symbol): PoolConnection => {
    const manager = getTransactionManager(datasource);
    if (!(manager instanceof MySQLTransactionManager)) {
        throw new TransactionContextMixingError(manager.constructor.name, DRIVER_NAME);
    }
    const transaction = manager.getCurrentTransaction();
    if (!transaction) throw new Error("Transaction context not initialized");
    return manager.wrapConnection(transaction);
};

export class MySQLTransactionManager extends PlatformTransactionManager<PoolConnection> {
    private readonly wrappers = new WeakMap<PoolConnection, PoolConnection>();

    constructor(private readonly pool: mysql2.Pool) {
        super();
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
                    const timeout = typeof config.timeout === "number" && config.timeout > 0
                        ? Math.min(config.timeout, remaining) : remaining;
                    args[0] = { ...config, timeout };
                    return value.apply(target, args).catch((error: unknown) => {
                        this.checkDeadline();
                        throw error;
                    });
                };
            },
        });
        this.wrappers.set(connection, wrapper);
        return wrapper;
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

    protected async commitTransaction(tx: PoolConnection): Promise<void> {
        await (tx as mysql2.PoolConnection).commit();
    }

    protected async rollbackTransaction(tx: PoolConnection): Promise<void> {
        await (tx as mysql2.PoolConnection).rollback();
    }

    protected async releaseTransaction(tx: PoolConnection, failed: boolean): Promise<void> {
        const connection = tx as mysql2.PoolConnection;
        if (failed) connection.destroy();
        else connection.release();
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
