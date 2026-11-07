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
    return transaction;
};

export class PostgreSQLTransactionManager extends PlatformTransactionManager<PoolClient> {
    protected readonly handlesCommitFailure = true;

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
            if (options?.timeout !== undefined) {
                // PostgreSQL's SET grammar does not accept bind parameters here.
                if (!Number.isFinite(options.timeout) || options.timeout < 0) {
                    throw new RangeError("Transaction timeout must be a non-negative finite number");
                }
                await connection.query(`SET LOCAL statement_timeout = ${Math.ceil(options.timeout)}`);
            }
            return { metadata: { driverName: DRIVER_NAME }, transaction: connection };
        } catch (error) {
            // BEGIN may have succeeded before configuring statement_timeout failed.
            let releaseError: Error | undefined;
            try { await connection.query("ROLLBACK"); }
            catch (rollbackError) { releaseError = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)); }
            connection.release(releaseError);
            throw error;
        }
    }

    protected async commitTransaction(tx: PoolClient): Promise<void> {
        let releaseError: Error | undefined;
        try {
            await tx.query("COMMIT");
        } catch (error) {
            try { await tx.query("ROLLBACK"); }
            catch (rollbackError) { releaseError = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)); }
            throw error;
        } finally {
            (tx as pg.PoolClient).release(releaseError);
        }
    }

    protected async rollbackTransaction(tx: PoolClient): Promise<void> {
        let releaseError: Error | undefined;
        try {
            await tx.query("ROLLBACK");
        } catch (error) {
            releaseError = error instanceof Error ? error : new Error(String(error));
            throw error;
        } finally {
            (tx as pg.PoolClient).release(releaseError);
        }
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
