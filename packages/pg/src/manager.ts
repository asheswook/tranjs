import { PostgreSQLConnection } from "./context";
import { Pool } from "pg";
import * as core from "@tranjs/core";

export function usePostgreSQLTransactionManager(pool: Pool) {
    const manager = new PostgreSQLTransactionManager(pool)
    core.useTransactionManager(manager)
}

export const ctx = core.ctx<PostgreSQLConnection>;

export class PostgreSQLTransactionManager extends core.PlatformTransactionManager<PostgreSQLConnection> {
    constructor(
        private readonly pool: Pool
    ) {
        super();
    }

    protected async beginTransaction(): Promise<PostgreSQLConnection> {
        const connection = await this.pool.connect();
        await connection.query("BEGIN");

        return new PostgreSQLConnection(connection);
    }

    protected async commitTransaction(tx: PostgreSQLConnection): Promise<void> {
        try {
            await tx.connection.query("COMMIT");
        } finally {
            tx.connection.release();
        }
    }

    protected async rollbackTransaction(tx: PostgreSQLConnection): Promise<void> {
        try {
            await tx.connection.query("ROLLBACK");
        } finally {
            tx.connection.release();
        }
    }
}