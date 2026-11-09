import type postgres from "postgres" with { "resolution-mode": "import" };

/**
 * The connection reserved for the current transaction, as returned by `ctx()`.
 *
 * It preserves postgres.js's reserved connection overloads (tagged queries, `unsafe`, helpers).
 * `begin`, `reserve`, `end`, `listen` and similar pool-level methods aren't part of it,
 * and it has no `release()` or dispose methods: TranJS releases the connection when the
 * transaction ends.
 */
export type TransactionSql<T extends Record<string, unknown> = {}> = postgres.ReservedSql<T> & ManagedMembers;

/**
 * Members TranJS manages. They are typed `never` (and hidden at runtime), so calling them
 * or using `ctx()` with `using` is a compile error. A reserved connection stays assignable
 * to `TransactionSql` the other way round only through the managers, which own it.
 */
type ManagedMembers = {
    readonly begin: never;
    readonly reserve: never;
    readonly end: never;
    readonly close: never;
    readonly listen: never;
    readonly subscribe: never;
    readonly largeObject: never;
    readonly release: never;
    readonly [Symbol.dispose]: never;
    readonly [Symbol.asyncDispose]: never;
};

/** The reserved connection itself. Internal to the managers. */
export type ReservedTransactionSql<T extends Record<string, unknown> = {}> = postgres.ReservedSql<T>;
