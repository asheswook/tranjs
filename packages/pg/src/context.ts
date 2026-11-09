import type * as Types from "pg";

// Use the common Client surface: PoolClient's fluent event methods return a
// PoolClient (including release), so merely omitting release does not fit Client.
// Both native Client and PoolClient fit this type; lifecycle methods stay hidden
// as before (except end, which was already exposed by the existing API).
export type PoolClient = Omit<Types.Client, 'connect'>;
