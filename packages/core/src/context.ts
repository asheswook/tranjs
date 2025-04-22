/**
 * Context for the current transaction.
 */
export interface TransactionContext {}

export interface TransactionMetadata {
    /**
     * Indicates what driver is being used for this transaction.
     */
    driverName: string | Symbol;
}

export interface MetadataWrappedTransaction<Tx extends TransactionContext> {
    transaction: Readonly<Tx>;
    metadata: Readonly<TransactionMetadata>;
}