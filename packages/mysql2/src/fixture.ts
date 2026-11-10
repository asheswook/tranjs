import type { FieldPacket } from "mysql2/promise";
import type { FixtureLease } from "@tranjs/core/internal/testing-bridge";
import type { PoolConnection } from "./context";

type Mysql2FixtureResult = Awaited<ReturnType<PoolConnection["query"]>>[0];

/** Restricted connection available only during a live fixture callback. */
export interface Mysql2FixtureConnection {
    query<T extends Mysql2FixtureResult = Mysql2FixtureResult>(text: string, values?: any[]): Promise<[T, FieldPacket[]]>;
    execute<T extends Mysql2FixtureResult = Mysql2FixtureResult>(text: string, values?: any[]): Promise<[T, FieldPacket[]]>;
}

export function createMysql2FixtureConnection(tx: PoolConnection, lease: FixtureLease): Mysql2FixtureConnection {
    const method = (name: "query" | "execute") =>
        <T extends Mysql2FixtureResult = Mysql2FixtureResult>(...args: [text: string, values?: any[]]): Promise<[T, FieldPacket[]]> => {
            lease.assert();
            if (args.length < 1 || args.length > 2 || typeof args[0] !== "string" ||
                (args[1] !== undefined && !Array.isArray(args[1]))) {
                throw new TypeError(`Fixture ${name} requires SQL text and an optional parameter array`);
            }
            return lease.track(() => name === "query" ? tx.query<T>(args[0], args[1]) : tx.execute<T>(args[0], args[1]));
        };
    return Object.assign(Object.create(null), { query: method("query"), execute: method("execute") });
}
