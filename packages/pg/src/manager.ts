import * as pg from "pg";
import {
    getTransactionManager,
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
    constructor(private readonly pool: pg.Pool) {
        super();
    }

    protected async beginTransaction(options?: TransactionOptions): Promise<MetadataWrappedTransaction<PoolClient>> {
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
            try { await connection.query("ROLLBACK"); } catch { /* preserve begin error */ }
            connection.release();
            throw error;
        }
    }

    protected async commitTransaction(tx: PoolClient): Promise<void> {
        try {
            await tx.query("COMMIT");
        } catch (error) {
            try { await tx.query("ROLLBACK"); } catch { /* preserve commit error */ }
            throw error;
        } finally {
            (tx as pg.PoolClient).release();
        }
    }

    protected async rollbackTransaction(tx: PoolClient): Promise<void> {
        try {
            await tx.query("ROLLBACK");
        } finally {
            (tx as pg.PoolClient).release();
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
