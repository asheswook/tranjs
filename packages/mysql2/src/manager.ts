import * as mysql2 from "mysql2/promise";
import * as core from "@tranjs/core";
import { PoolConnection } from "./context";
import {MetadataWrappedTransaction} from "@tranjs/core";
import {AsyncLocal} from "@tranjs/core/dist/asyncLocal";

const DRIVER_NAME = Symbol('mysql2');

export function useMySQLTransactionManager(pool: mysql2.Pool) {
    const manager = new MySQLTransactionManager(pool)
    core.useTransactionManager(manager)
}

/**
 * Get the current transaction context.
 * Use in the @Transactional method.
 * @example
 * ```ts
 * import { Transactional } from "@tranjs/core";
 * import { ctx } from "@tranjs/mysql2";
 *
 * class MyService {
 *   @Transactional()
 *   async myMethod() {
 *     const res = await ctx().query("SELECT * FROM users");
 *   }
 * }
 * ```
 */
export const ctx = () => {
    const context = AsyncLocal.Context;
    if (!context) throw new Error("Transaction context not initialized");
    if (context.metadata.driverName !== DRIVER_NAME) throw new Error("Transaction context not initialized");
    return context.transaction as PoolConnection;
}

export class MySQLTransactionManager extends core.PlatformTransactionManager<PoolConnection> {
    constructor(
        private readonly pool: mysql2.Pool
    ) {
        super();
    }

    protected async beginTransaction(): Promise<MetadataWrappedTransaction<PoolConnection>> {
        const connection = await this.pool.getConnection()
        await connection.beginTransaction()

        return {
            metadata: {
                driverName: DRIVER_NAME,
            },
            transaction: connection,
        } satisfies MetadataWrappedTransaction<PoolConnection>;
    }

    protected async commitTransaction(tx: PoolConnection): Promise<void> {
        try {
            // TODO: dangerous type assertion
            await (tx as mysql2.PoolConnection).commit()
        } finally {
            (tx as mysql2.PoolConnection).release()
        }
    }

    protected async rollbackTransaction(tx: PoolConnection): Promise<void> {
        try {
            // TODO: dangerous type assertion
            await (tx as mysql2.PoolConnection).rollback()
        } finally {
            (tx as mysql2.PoolConnection).release()
        }
    }
}