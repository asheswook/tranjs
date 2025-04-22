import { MetadataWrappedTransaction, TransactionContext } from "./context";
import { Propagation } from "./propagation";
import { AsyncLocal } from "./asyncLocal";
import { IllegalTransactionStateException, UnsupportedTransactionPropagationException } from "./error";

export let GlobalTransactionManager: PlatformTransactionManager<TransactionContext>;

/**
 * @deprecated
 * Do not use this `ctx()` directly. This is not type safe.
 * Use `ctx()` of **EACH DRIVER** instead.
 * @example
 * ```ts
 * import { ctx } from "@tranjs/mysql2";
 * ```
 */
export function ctx<Tx extends TransactionContext>(): Tx {
    const context = AsyncLocal.Context;
    if (!context) {
        throw new Error("No transaction context available");
    }

    return context.transaction as Tx;
}

export function useTransactionManager<Tx extends TransactionContext>(
    transactionManager: PlatformTransactionManager<Tx>,
): void {
    GlobalTransactionManager = transactionManager;
}

export abstract class PlatformTransactionManager<Tx extends TransactionContext> {
    protected constructor() {}

    getCurrentTransaction(): Tx | undefined {
        return AsyncLocal.Context?.transaction as Tx;
    }

    protected abstract beginTransaction(): Promise<MetadataWrappedTransaction<Tx>>;

    protected abstract commitTransaction(tx: Tx): Promise<void>;

    protected abstract rollbackTransaction(tx: Tx): Promise<void>;

    private async executeNewTransaction<Return>(
        callback: (tx: Tx) => Promise<Return> | Return,
    ): Promise<Return> {
        const newTx = await this.beginTransaction();
        return AsyncLocal.Run(newTx, async () => {
            try {
                const result = await callback(newTx.transaction);
                await this.commitTransaction(newTx.transaction);
                return result;
            } catch (error) {
                await this.rollbackTransaction(newTx.transaction);
                throw error;
            }
        });
    }

    public async executeTransaction<Return>(
        propagation: Propagation = Propagation.REQUIRED,
        callback: (tx: Tx) => Return | Promise<Return>,
    ): Promise<Return> {
        const existingTx = this.getCurrentTransaction();

        switch (propagation) {
            case Propagation.REQUIRES_NEW:
                // Always starts a new transaction
                return this.executeNewTransaction(callback);

            case Propagation.REQUIRED:
                // Reuse tx if exists, or starts new tx if not exists
                return existingTx ? callback(existingTx) : this.executeNewTransaction(callback);

            case Propagation.MANDATORY:
                if (!existingTx) {
                    // If no existing transaction, throw an exception
                    throw new IllegalTransactionStateException(propagation);
                }
                return callback(existingTx);

            // case Propagation.SUPPORTS:
            //     // If an existing transaction is present, use it; otherwise, execute without a transaction
            //     if (existingTx) {
            //         return callback(existingTx);
            //     }
            //     // No transaction context, execute without a transaction (implementation needed)
            //     throw new Error("Not implemented");
            //
            // case Propagation.NOT_SUPPORTED:
            //     // If an existing transaction is present, suspend it; otherwise, execute without a transaction
            //     throw new Error("Not implemented");
            //
            // case Propagation.NEVER:
            //     if (existingTx) {
            //         // If an existing transaction is present, throw an exception
            //         throw new IllegalTransactionStateException(propagation);
            //     }
            //     // No transaction context, execute without a transaction (implementation needed)
            //     throw new Error("Not implemented");

            default:
                throw new UnsupportedTransactionPropagationException();
        }
    }
}