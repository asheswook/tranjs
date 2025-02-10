import {PlatformTransactionManager} from "@tranjs/core";
import {MySQLConnection} from "./context";
import {Pool} from "mysql2/promise";

export class MySQLTransactionManager extends PlatformTransactionManager<MySQLConnection> {
    constructor(
        private readonly pool: Pool
    ) {
        super();
    }

    protected async beginTransaction(): Promise<MySQLConnection> {
        const connection = await this.pool.getConnection()
        await connection.beginTransaction()

        return new MySQLConnection(connection)
    }

    protected async commitTransaction(tx: MySQLConnection): Promise<void> {
        try {
            await tx.connection.commit()
        } finally {
            tx.connection.release()
        }
    }

    protected async rollbackTransaction(tx: MySQLConnection): Promise<void> {
        try {
            await tx.connection.rollback()
        } finally {
            tx.connection.release()
        }
    }
}