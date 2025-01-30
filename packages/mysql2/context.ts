import { TransactionContext } from "@tranjs/core";
import { Pool, PoolConnection } from "mysql2/promise";

export class MySQLConnection implements TransactionContext {
    constructor(public connection: PoolConnection) {}

    async execute(query: string, params?: any[]): Promise<any> {
        return this.connection.execute(query, params)
    }
}