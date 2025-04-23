import { Propagation } from "./propagation";

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
    constructor() {
        super(`Datasource is not set up. `);
        this.name = 'TransactionDatasourceSetupError';
    }
}

export class TransactionContextMixingError extends Error {
    constructor(currentDriver: string | Symbol, transactionDriver: string | Symbol) {
        super(`Transaction context mixing error: Current active context driver is '${currentDriver.toString()}', but tried to use ctx() of '${transactionDriver.toString()}'.`);
        this.name = 'TransactionContextMixingError';
    }
}