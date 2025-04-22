import { Propagation } from "./propagation";

export interface TransactionConfig {
    // /**
    //  * The name of the transaction. just for logging purposes.
    //  */
    // name?: string;

    // /**
    //  * The isolation level of the transaction.
    //  */
    // isolationLevel?: string;

    /**
     * The timeout of the transaction in milliseconds.
     */
    timeout?: number;

    /**
     * The propagation behavior of the transaction.
     */
    propagation?: Propagation;
}