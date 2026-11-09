import type postgres from "postgres" with { "resolution-mode": "import" };

/** The reserved connection shared by both transaction modes. TranJS owns release. */
export type TransactionSql<T extends Record<string, unknown> = {}> = postgres.ReservedSql<T>;
