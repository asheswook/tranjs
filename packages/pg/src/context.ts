import { TransactionContext } from '@tranjs/core';
import { PoolClient, QueryResult } from "pg";

export class PostgreSQLConnection implements TransactionContext<QueryResult> {
    constructor(public connection: PoolClient) {}

    async execute(query: string, params?: any[]): Promise<QueryResult> {
        return this.connection.query(query, params);
    }
}