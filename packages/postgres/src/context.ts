import type postgres from "postgres";

/** The reserved connection shared by both transaction modes. TranJS owns release. */
export type TransactionSql = postgres.ReservedSql;
