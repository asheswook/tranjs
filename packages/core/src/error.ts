import { Propagation } from "./propagation";

export class TransactionSystemError extends Error {
    readonly cause: unknown;

    constructor(cause: unknown, public readonly applicationError: unknown) {
        super("Transaction rollback failed after application error");
        this.name = "TransactionSystemError";
        this.cause = cause;
    }
}

export class ConcurrentNestedTransactionError extends Error {
    constructor() {
        super("A sibling nested transaction is still open in this parent scope");
        this.name = "ConcurrentNestedTransactionError";
    }
}

export class UnexpectedRollbackError extends Error {
    constructor() {
        super("Transaction was marked rollback-only and could not be committed");
        this.name = "UnexpectedRollbackError";
    }
}

export class InvalidIsolationLevelError extends TypeError {
    constructor(level: unknown) {
        super(`Invalid transaction isolation level: ${String(level)}`);
        this.name = "InvalidIsolationLevelError";
    }
}

export class IllegalTransactionStateException extends Error {
    constructor(propagation: string) {
        super(`Illegal transaction state: ${propagation}`);
        this.name = 'IllegalTransactionStateException';
    }
}

export class UnsupportedTransactionPropagationException extends Error {
    constructor() {
        super(`Unsupported propagation. Supported propagations: ${Object.values(Propagation).join(", ")}`);
        this.name = 'UnsupportedTransactionPropagationException';
    }
}

export class DatasourceSetupError extends Error {
    constructor(name: string | symbol = "DEFAULT_DATASOURCE") {
        super(`Datasource is not set up: ${String(name)}`);
        this.name = 'TransactionDatasourceSetupError';
    }
}

export class TransactionTimeoutError extends Error {
    constructor(timeout: number) {
        super(`Transaction timed out after ${timeout}ms`);
        this.name = "TransactionTimeoutError";
    }
}

export class NestedTransactionNotSupportedError extends UnsupportedTransactionPropagationException {
    constructor() {
        super();
        this.message = "Nested transactions are not supported by this transaction manager";
        this.name = "NestedTransactionNotSupportedError";
    }
}

export class NoTransactionContextError extends Error {
    constructor() {
        super("No transaction context available");
        this.name = "NoTransactionContextError";
    }
}

export class TransactionContextMixingError extends Error {
    constructor(currentDriver: string | Symbol, transactionDriver: string | Symbol) {
        super(`Transaction context mixing error: Current active context driver is '${currentDriver.toString()}', but tried to use ctx() of '${transactionDriver.toString()}'.`);
        this.name = 'TransactionContextMixingError';
    }
}
export class TransactionClosedError extends Error {
    constructor() {
        super("Transaction already finished");
        this.name = "TransactionClosedError";
    }
}
