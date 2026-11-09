import type * as Types from "mysql2/promise";

// Use the common Connection surface: PoolConnection also exposes a pool-only
// connection property and fluent event methods returning a PoolConnection.
// Both connection modes fit this type without exposing lifecycle methods.
export type PoolConnection = Omit<
    Types.Connection,
    'connect' |
    'end' |
    'destroy' |
    'beginTransaction' |
    'release' |
    'commit' |
    'rollback'
>;
