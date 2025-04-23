import * as pg from "pg";
import * as core from "@tranjs/core";
import { PoolClient } from "./context";
import {MetadataWrappedTransaction, TransactionContextMixingError} from "@tranjs/core";
import { AsyncLocal } from "@tranjs/core/dist/asyncLocal";

const DRIVER_NAME = Symbol('pg');

export function usePostgreSQLTransactionManager(pool: pg.Pool) {
    const manager = new PostgreSQLTransactionManager(pool)
    core.useTransactionManager(manager)
}

/**
 * Get the current transaction context.
 * Use in the @Transactional method.
 * @example
 * ```ts
 * import { Transactional } from "@tranjs/core";
 * import { ctx } from "@tranjs/pg";
 *
 * class MyService {
 *   ⁣@Transactional()
 *   async myMethod() {
 *     const res = await ctx().query("SELECT * FROM users");
 *   }
 * }
 * ```
 */
export const ctx = () => {
    const context = AsyncLocal.Context;
    if (!context) throw new Error("Transaction context not initialized");
    if (context.metadata.driverName !== DRIVER_NAME) throw new TransactionContextMixingError(context.metadata.driverName, DRIVER_NAME);
    return context.transaction as PoolClient;
}

export class PostgreSQLTransactionManager extends core.PlatformTransactionManager<PoolClient> {
    constructor(
        private readonly pool: pg.Pool
    ) {
        super();
    }

    protected async beginTransaction(): Promise<MetadataWrappedTransaction<PoolClient>> {
        const connection = await this.pool.connect();
        await connection.query("BEGIN");

        return {
            metadata: {
                driverName: DRIVER_NAME,
            },
            transaction: connection,
        } satisfies MetadataWrappedTransaction<PoolClient>
    }

    protected async commitTransaction(tx: PoolClient): Promise<void> {
        try {
            await tx.query("COMMIT");
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
}