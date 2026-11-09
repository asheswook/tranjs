import * as pg from "pg";
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
import { PoolClient } from "./context";

const DRIVER_NAME = Symbol("pg");

export function usePostgreSQLTransactionManager(pool: pg.Pool, name?: string | symbol) {
    const manager = new PostgreSQLTransactionManager(pool);
    useTransactionManager(manager, name);
}

/** Get this datasource's active PostgreSQL transaction. */
export const ctx = (datasource?: string | symbol): PoolClient => {
    const manager = getTransactionManager(datasource);
    if (!(manager instanceof PostgreSQLTransactionManager)) {
        throw new TransactionContextMixingError(manager.constructor.name, DRIVER_NAME);
    }
    const transaction = manager.getCurrentTransaction();
    if (!transaction) throw new Error("Transaction context not initialized");
    return manager.wrapConnection(transaction);
};

export class PostgreSQLTransactionManager extends PlatformTransactionManager<PoolClient> {
    private readonly wrappers = new WeakMap<PoolClient, PoolClient>();

    constructor(private readonly pool: pg.Pool) {
        super();
    }

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
                    if (remaining === undefined) return value.apply(target, args);
                    const config = args[0];
                    const timeout = typeof config?.query_timeout === "number" && config.query_timeout > 0
                        ? Math.min(config.query_timeout, remaining) : remaining;
                    // pg supports query_timeout at runtime, though QueryConfig's types omit it.
                    args[0] = typeof config === "string" ? { text: config, query_timeout: timeout }
                        : typeof config?.submit === "function"
                            ? new Proxy(config, { get: (query, key) => key === "query_timeout" ? timeout : Reflect.get(query, key) })
                            : { ...config, query_timeout: timeout };
                    const deadlineBound = timeout === remaining;
                    const deadlineError = (error: unknown) => {
                        if (!error) return error;
                        if (deadlineBound && error instanceof Error && error.message === "Query read timeout") {
                            return this.expireTransaction() ?? error;
                        }
                        try { this.checkDeadline(); } catch (timeoutError) { return timeoutError; }
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

    protected async commitTransaction(tx: PoolClient): Promise<void> {
        await tx.query("COMMIT");
    }

    protected async rollbackTransaction(tx: PoolClient): Promise<void> {
        await tx.query("ROLLBACK");
    }

    protected async releaseTransaction(tx: PoolClient, failed: boolean): Promise<void> {
        (tx as pg.PoolClient).release(failed ? new Error("Transaction completion failed") : undefined);
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
