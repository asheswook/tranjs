import { AbstractUnitOfWork, TransactionContext } from "@node-transaction/core";
import { Pool, PoolConnection } from "mysql2/promise";

export class MySQLConnection implements TransactionContext {
    constructor(public connection: PoolConnection) {}

    async execute(query: string, params: any[]): Promise<any> {
        return this.connection.execute(query, params)
    }
}

export class MySQLUnitOfWork extends AbstractUnitOfWork<MySQLConnection>{
    private readonly pool: Pool;

    constructor(pool: Pool) {
        super();
        this.pool = pool;
    }

    async beginTransaction(): Promise<MySQLConnection> {
        const connection = await this.pool.getConnection()

        return new MySQLConnection(connection)
    }

    async commitTransaction(tx: MySQLConnection): Promise<void> {
        try {
            await tx.connection.commit()
        } finally {
            tx.connection.release()
        }
    }

    async rollbackTransaction(tx: MySQLConnection): Promise<void> {
        try {
            await tx.connection.rollback()
        } finally {
            tx.connection.release()
        }
    }
}