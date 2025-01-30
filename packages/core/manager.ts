import {TransactionContext} from "./context";
import {Propagation} from "./propagation";
import {AsyncLocal} from "./asyncLocal";
import {IllegalTransactionStateException} from "./error";

export abstract class PlatformTransactionManager<Tx extends TransactionContext> {
    protected constructor() {}

    getCurrentTransaction(): Tx | undefined {
        return AsyncLocal.Context as Tx;
    }

    protected abstract beginTransaction(): Promise<Tx>;

    protected abstract commitTransaction(tx: Tx): Promise<void>;

    protected abstract rollbackTransaction(tx: Tx): Promise<void>;

    async executeTransaction(
        propagation: Propagation = Propagation.REQUIRED,
        callback: (tx: Tx) => Promise<any>,
    ): Promise<any> {
        const existingTx = this.getCurrentTransaction();

        if (propagation === Propagation.REQUIRES_NEW) {
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
        } else if (propagation === Propagation.REQUIRED && existingTx) {
            return callback(existingTx);
        } else if (propagation === Propagation.REQUIRED && !existingTx) {
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
        } else if (propagation === Propagation.MANDATORY) {
            if (!existingTx) {
                throw new IllegalTransactionStateException(propagation);
            }

            return callback(existingTx);
        } else if (propagation === Propagation.SUPPORTS) {
            if (existingTx) {
                return callback(existingTx);
            }

            throw new Error("Not implemented");
        } else if (propagation === Propagation.NOT_SUPPORTED) {
            throw new Error("Not implemented");
        } else if (propagation === Propagation.NEVER) {
            if (existingTx) {
                throw new IllegalTransactionStateException(propagation);
            }

            throw new Error("Not implemented");
        }

        throw new Error("Unsupported propagation: " + propagation);
    }
}