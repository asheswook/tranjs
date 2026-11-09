import type * as pg from "pg";
import type * as mysql from "mysql2/promise";
import postgres from "postgres";
import {
    ctx as postgresCtx,
    TransactionSql,
    PostgresTransactionManager,
    PostgresConnectionPerTransactionManager,
    usePostgresTransactionManager,
    usePostgresConnectionPerTransaction,
} from "@tranjs/postgres";
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
export type PostgresCtxTransactionSql = Expect<Equal<ReturnType<typeof postgresCtx>, TransactionSql>>;
// ctx() must not expose members TranJS owns.
export function postgresManagedMembers(tx: TransactionSql): void {
    // @ts-expect-error TranJS releases the connection; ctx() has no release().
    tx.release();
    // @ts-expect-error No `using` disposal: it would release before commit.
    tx[Symbol.dispose]();
    // @ts-expect-error Pool-level transactions aren't available inside a TranJS transaction.
    void tx.begin(async () => {});
    // @ts-expect-error Ending the pool from inside a transaction isn't allowed.
    void tx.end();
}


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

// Compile native postgres.js composition, query modes, and both registrations.
export function postgresConsumerChecks(sql: postgres.Sql, reserved: postgres.ReservedSql,
    options: postgres.Options<{}>): void {
    const helper = (transaction: TransactionSql) => transaction`SELECT ${42}::integer AS value`;
    // @ts-expect-error A raw reserved connection exposes release(); TranJS hands out TransactionSql instead.
    void helper(reserved);
    void helper(postgresCtx());
    void helper(postgresCtx("named"));
    void postgresCtx()`SELECT ${postgresCtx()("id")} FROM ${postgresCtx()("items")} WHERE id = ${1}`;
    void postgresCtx().unsafe<{ value: number }[]>("SELECT $1::integer AS value", [42]);
    void postgresCtx()`SELECT 1`.execute();
    void postgresCtx()`SELECT 1`.cursor(2);
    void postgresCtx()`SELECT 1`.forEach(row => { void row; });
    void postgresCtx().unsafe("COPY (SELECT 1) TO STDOUT").readable();
    const typed = postgresCtx<{ bigint: bigint }>();
    void typed`SELECT ${typed.typed.bigint(BigInt(42))}, ${typed.types.bigint(BigInt(42))}`;
    void new PostgresTransactionManager(sql);
    usePostgresTransactionManager(sql, Symbol("postgres"));
    void new PostgresConnectionPerTransactionManager("postgres://localhost/test");
    void new PostgresConnectionPerTransactionManager(options);
    void new PostgresConnectionPerTransactionManager(() => options);
    void new PostgresConnectionPerTransactionManager(async () => options);
    usePostgresConnectionPerTransaction(options);
    usePostgresConnectionPerTransaction(() => "postgres://localhost/test", "named");
    usePostgresConnectionPerTransaction(async () => "postgres://localhost/test", Symbol("named"));
    // @ts-expect-error A pool is not a reservation and has no release() method.
    void helper(sql);
    // @ts-expect-error The pool manager requires the caller-owned Sql pool.
    void new PostgresTransactionManager(reserved);
}
