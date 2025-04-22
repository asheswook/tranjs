import type * as Types from "pg";

export type PoolClient = Omit<
    Types.PoolClient,
    'connect' |
    'release'
>