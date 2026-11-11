import type * as pg from "pg";
import type { TestConnectionLease } from "@tranjs/core/internal/testing-bridge";
import type { PoolClient } from "./context";

/** Restricted connection available only during a live withTestConnection callback. */
export interface TestConnection {
    query<R extends pg.QueryResultRow = any>(text: string, values?: any[]): Promise<pg.QueryResult<R>>;
}

export function createPgTestConnection(tx: PoolClient, lease: TestConnectionLease): TestConnection {
    return Object.assign(Object.create(null), {
        query<R extends pg.QueryResultRow = any>(...args: [text: string, values?: any[]]): Promise<pg.QueryResult<R>> {
            lease.assert();
            if (args.length < 1 || args.length > 2 || typeof args[0] !== "string" ||
                (args[1] !== undefined && !Array.isArray(args[1]))) {
                throw new TypeError("withTestConnection query requires SQL text and an optional parameter array");
            }
            return lease.track(() => tx.query<R>(args[0], args[1]));
        },
    });
}
