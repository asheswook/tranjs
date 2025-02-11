import { TransactionContext } from "@tranjs/core";
import {FieldPacket, Pool, PoolConnection, QueryResult} from "mysql2/promise";

export class MySQLConnection implements TransactionContext<[QueryResult, FieldPacket[]]> {
    constructor(public connection: PoolConnection) {}

    async execute<T extends QueryResult>(query: string, params?: any[]): Promise<[T, FieldPacket[]]> {
        return this.connection.execute<T>(query, params)
    }
}