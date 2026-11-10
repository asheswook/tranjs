import type * as pg from "pg";
import type { FixtureLease } from "@tranjs/core/internal/testing-bridge";
import type { PoolClient } from "./context";

/** Restricted connection available only during a live fixture callback. */
export interface PgFixtureConnection {
    query<R extends pg.QueryResultRow = any>(text: string, values?: any[]): Promise<pg.QueryResult<R>>;
}

export function createPgFixtureConnection(tx: PoolClient, lease: FixtureLease): PgFixtureConnection {
    return Object.assign(Object.create(null), {
        query<R extends pg.QueryResultRow = any>(...args: [text: string, values?: any[]]): Promise<pg.QueryResult<R>> {
            lease.assert();
            if (args.length < 1 || args.length > 2 || typeof args[0] !== "string" ||
                (args[1] !== undefined && !Array.isArray(args[1]))) {
                throw new TypeError("Fixture query requires SQL text and an optional parameter array");
            }
            return lease.track(() => tx.query<R>(args[0], args[1]));
        },
    });
}
