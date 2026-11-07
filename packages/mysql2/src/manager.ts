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
    return transaction;
};

export class MySQLTransactionManager extends PlatformTransactionManager<PoolConnection> {
    protected readonly handlesCommitFailure = true;

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

    protected async commitTransaction(tx: PoolConnection): Promise<void> {
        const connection = tx as mysql2.PoolConnection;
        let dirty = false;
        try {
            await connection.commit();
        } catch (error) {
            try { await connection.rollback(); } catch { dirty = true; }
            throw error;
        } finally {
            if (dirty) connection.destroy();
            else connection.release();
        }
    }

    protected async rollbackTransaction(tx: PoolConnection): Promise<void> {
        const connection = tx as mysql2.PoolConnection;
        let dirty = false;
        try {
            await connection.rollback();
        } catch (error) {
            dirty = true;
            throw error;
        } finally {
            if (dirty) connection.destroy();
            else connection.release();
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
