import { PlatformTransactionManager } from "@tranjs/core";
import { PostgreSQLConnection } from "./context";
import { Pool } from "pg";

export class PostgreSQLTransactionManager extends PlatformTransactionManager<PostgreSQLConnection> {
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