import type { FieldPacket } from "mysql2/promise";
import type { TestConnectionLease } from "@tranjs/core/internal/testing-bridge";
import type { PoolConnection } from "./context";

type Mysql2TestConnectionResult = Awaited<ReturnType<PoolConnection["query"]>>[0];

/** Restricted connection available only during a live withTestConnection callback. */
export interface TestConnection {
    query<T extends Mysql2TestConnectionResult = Mysql2TestConnectionResult>(text: string, values?: any[]): Promise<[T, FieldPacket[]]>;
    execute<T extends Mysql2TestConnectionResult = Mysql2TestConnectionResult>(text: string, values?: any[]): Promise<[T, FieldPacket[]]>;
}

export function createMysql2TestConnection(tx: PoolConnection, lease: TestConnectionLease): TestConnection {
    const method = (name: "query" | "execute") =>
        <T extends Mysql2TestConnectionResult = Mysql2TestConnectionResult>(...args: [text: string, values?: any[]]): Promise<[T, FieldPacket[]]> => {
            lease.assert();
            if (args.length < 1 || args.length > 2 || typeof args[0] !== "string" ||
                (args[1] !== undefined && !Array.isArray(args[1]))) {
                throw new TypeError(`withTestConnection ${name} requires SQL text and an optional parameter array`);
            }
            return lease.track(() => name === "query" ? tx.query<T>(args[0], args[1]) : tx.execute<T>(args[0], args[1]));
        };
    return Object.assign(Object.create(null), { query: method("query"), execute: method("execute") });
}
