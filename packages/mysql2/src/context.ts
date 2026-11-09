import type * as Types from "mysql2/promise";

export type PoolConnection = Omit<
    Types.PoolConnection,
    'connect' |
    'end' |
    'destroy' |
    'beginTransaction' |
    'release' |
    'commit' |
    'rollback'
>;

/** Common query surface for helpers accepting either transaction mode. */
export type TransactionConnection = Omit<
    Types.Connection,
    'connect' |
    'end' |
    'destroy' |
    'beginTransaction' |
    'commit' |
    'rollback'
>;
