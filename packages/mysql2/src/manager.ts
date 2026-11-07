import * as mysql2 from "mysql2/promise";
import {
    getTransactionManager,
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
    return transaction;
};

export class MySQLTransactionManager extends PlatformTransactionManager<PoolConnection> {
    constructor(private readonly pool: mysql2.Pool) {
        super();
    }

    protected async beginTransaction(options?: TransactionOptions): Promise<MetadataWrappedTransaction<PoolConnection>> {
        const connection = await this.pool.getConnection();
        try {
            if (options?.isolationLevel) {
                await connection.query(`SET TRANSACTION ISOLATION LEVEL ${options.isolationLevel}`);
            }
            await connection.query(`START TRANSACTION${options?.readOnly ? " READ ONLY" : ""}`);
            return { metadata: { driverName: DRIVER_NAME }, transaction: connection };
        } catch (error) {
            connection.release();
            throw error;
        }
    }

    protected async commitTransaction(tx: PoolConnection): Promise<void> {
        const connection = tx as mysql2.PoolConnection;
        try {
            await connection.commit();
        } catch (error) {
            try { await connection.rollback(); } catch { /* preserve commit error */ }
            throw error;
        } finally {
            connection.release();
        }
    }

    protected async rollbackTransaction(tx: PoolConnection): Promise<void> {
        try {
            await (tx as mysql2.PoolConnection).rollback();
        } finally {
            (tx as mysql2.PoolConnection).release();
        }
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
