import { AbstractUnitOfWork, TransactionContext } from "./unitOfWork";
import { AsyncLocalStorage } from "node:async_hooks";
import { Propagation } from "./propagation";

export class TransactionManager<Tx extends TransactionContext> {
    private unitOfWork: AbstractUnitOfWork<Tx>;
    private asyncLocalStorage: AsyncLocalStorage<Tx>;

    constructor(unitOfWork: AbstractUnitOfWork<Tx>) {
        this.unitOfWork = unitOfWork;
        this.asyncLocalStorage = new AsyncLocalStorage<Tx>();
    }

    getCurrentTransaction(): Tx | undefined {
        return this.asyncLocalStorage.getStore();
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
        callback: (tx: Tx) => Promise<any>,
        propagation: Propagation = Propagation.REQUIRED
    ): Promise<any> {
        const existingTx = this.getCurrentTransaction();

        if (propagation === 'REQUIRES_NEW' || !existingTx) {
            const newTx = await this.beginTransaction();
            return this.asyncLocalStorage.run(newTx, async () => {
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