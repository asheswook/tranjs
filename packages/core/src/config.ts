import { Propagation } from "./propagation";

export enum IsolationLevel {
    READ_UNCOMMITTED = "READ UNCOMMITTED",
    READ_COMMITTED = "READ COMMITTED",
    REPEATABLE_READ = "REPEATABLE READ",
    SERIALIZABLE = "SERIALIZABLE",
}

export const DEFAULT_DATASOURCE: unique symbol = Symbol("DEFAULT_DATASOURCE");

export interface TransactionOptions {
    isolationLevel?: IsolationLevel;
    readOnly?: boolean;
    /** Physical transaction deadline in milliseconds; checked before queries and commit. */
    timeout?: number;
}

export interface TransactionConfig extends TransactionOptions {
    propagation?: Propagation;
    datasource?: string | symbol;
}
