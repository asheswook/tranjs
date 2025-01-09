import { AbstractUnitOfWork, TransactionContext } from "./unitOfWork";
import { AsyncLocalStorage } from "node:async_hooks";
import { Propagation } from "./propagation";

export class AsyncLocal {
    private static storage = new AsyncLocalStorage<TransactionContext>();

    // static class
    private constructor() {}

    static get Context() {
        return AsyncLocal.storage.getStore();
    }

    static Run<T>(context: TransactionContext, callback: () => T): T {
        return AsyncLocal.storage.run(context, callback);
    }
}

export class PlatformTransactionManager<Tx extends TransactionContext> {
    private unitOfWork: AbstractUnitOfWork<Tx>;

    constructor(unitOfWork: AbstractUnitOfWork<Tx>) {
        this.unitOfWork = unitOfWork;
    }

    getCurrentTransaction(): Tx | undefined {
        return AsyncLocal.Context as Tx;
    }

    private async beginTransaction(): Promise<Tx> {
        return await this.unitOfWork.beginTransaction();
    }

    private async commitTransaction(tx: Tx): Promise<void> {
        return await this.unitOfWork.commitTransaction(tx);
    }

    private async rollbackTransaction(tx: Tx): Promise<void> {
        return await this.unitOfWork.rollbackTransaction(tx);
    }

    async executeTransaction(
        propagation: Propagation = Propagation.REQUIRED,
        callback: (tx: Tx) => Promise<any>,
    ): Promise<any> {
        const existingTx = this.getCurrentTransaction();

        if (propagation === 'REQUIRES_NEW' || !existingTx) {
            const newTx = await this.beginTransaction();
            return AsyncLocal.Run(newTx, async () => {
                try {
                    const result = await callback(newTx);
                    await this.commitTransaction(newTx);
                    return result;
                } catch (error) {
                    await this.rollbackTransaction(newTx);
                    throw error;
                }
            });
        } else if (propagation === 'REQUIRED') {
            if (!existingTx) {
                throw new Error('Unexpected Error: No existing transaction found');
            }

            try {
                return await callback(existingTx);
            } catch (error) {
                await this.rollbackTransaction(existingTx);
                throw error;
            }
        }

        throw new Error(`Unsupported propagation: ${propagation}`);
    }
}