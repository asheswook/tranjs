import { TransactionContext } from "@tranjs/core";
import {FieldPacket, Pool, PoolConnection, QueryResult} from "mysql2/promise";

export class MySQLConnection implements TransactionContext<[QueryResult, FieldPacket[]]> {
    constructor(public connection: PoolConnection) {}

    async execute(query: string, params?: any[]): Promise<[QueryResult, FieldPacket[]]> {
        return this.connection.execute(query, params)
    }
}