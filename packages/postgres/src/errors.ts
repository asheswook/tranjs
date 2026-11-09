/** PostgreSQL acknowledged COMMIT with ROLLBACK after an earlier statement error. */
export class TransactionAbortedError extends Error {
    constructor() {
        super("COMMIT was rolled back by the server because the transaction was aborted by an earlier error");
        this.name = "TransactionAbortedError";
    }
}
