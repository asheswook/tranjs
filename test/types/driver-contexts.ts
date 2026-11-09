import type * as pg from "pg";
import type * as mysql from "mysql2/promise";
import { ctx as pgCtx, PoolClient, TransactionClient } from "@tranjs/pg";
import {
    ctx as mysqlCtx, PoolConnection, TransactionConnection, MySQLConnectionPerTransactionOptions,
} from "@tranjs/mysql2";

// Frozen 1.1.0 definitions: do not replace these with the exported aliases.
type LegacyPg = Omit<pg.PoolClient, "connect" | "release">;
type LegacyMySQL = Omit<mysql.PoolConnection,
    "connect" | "end" | "destroy" | "beginTransaction" | "release" | "commit" | "rollback">;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

export type PgAliasUnchanged = Expect<Equal<PoolClient, LegacyPg>>;
export type MySQLAliasUnchanged = Expect<Equal<PoolConnection, LegacyMySQL>>;
export type PgCtxUnchanged = Expect<Equal<ReturnType<typeof pgCtx>, LegacyPg>>;
export type MySQLCtxUnchanged = Expect<Equal<ReturnType<typeof mysqlCtx>, LegacyMySQL>>;

// This is compiled, not executed: cover old consumers and both new helper types.
export function consumerChecks(pgClient: pg.Client, pgPoolClient: pg.PoolClient,
    mysqlConnection: mysql.Connection, mysqlPoolConnection: mysql.PoolConnection): void {
    const legacyPgHelper = (client: LegacyPg) => client.query("SELECT 1");
    const legacyMySQLHelper = (connection: LegacyMySQL) => connection.query("SELECT 1");
    void legacyPgHelper(pgCtx());
    void legacyMySQLHelper(mysqlCtx());
    const pgHelper = (client: TransactionClient) => client.query("SELECT 1");
    const mysqlHelper = (connection: TransactionConnection) => connection.query("SELECT 1");
    void pgHelper(pgClient);
    void pgHelper(pgPoolClient);
    void pgHelper(pgCtx());
    void mysqlHelper(mysqlConnection);
    void mysqlHelper(mysqlPoolConnection);
    void mysqlHelper(mysqlCtx());
}

export const isolationPolicy: MySQLConnectionPerTransactionOptions = { isolationLevelSupport: "apply" };
// @ts-expect-error The manager policy must not be confused with the transaction's isolationLevel.
export const removedPolicy: MySQLConnectionPerTransactionOptions = { isolationLevel: "apply" };
