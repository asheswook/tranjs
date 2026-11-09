import type * as Types from "pg";

export type PoolClient = Omit<
    Types.PoolClient,
    'connect' |
    'release'
>

/** Common query surface for helpers accepting either transaction mode. */
export type TransactionClient = Omit<Types.Client, 'connect'>;
