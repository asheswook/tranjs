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