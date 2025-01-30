export class IllegalTransactionStateException extends Error {
    constructor(propagation: string) {
        super(`Illegal transaction state: ${propagation}`);
        this.name = 'IllegalTransactionStateException';
    }
}