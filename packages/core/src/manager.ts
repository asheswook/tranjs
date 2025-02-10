import {TransactionContext} from "./context";
import {Propagation} from "./propagation";
import {AsyncLocal} from "./asyncLocal";
import {IllegalTransactionStateException, UnsupportedTransactionPropagationException} from "./error";

export let GlobalTransactionManager: PlatformTransactionManager<TransactionContext>;

export function ctx<Tx extends TransactionContext>(): Tx {
    return AsyncLocal.Context as Tx;
}

export function useTransactionManager<Tx extends TransactionContext>(
    transactionManager: PlatformTransactionManager<Tx>,
): void {
    GlobalTransactionManager = transactionManager;
}

export abstract class PlatformTransactionManager<Tx extends TransactionContext> {
    protected constructor() {}

    getCurrentTransaction(): Tx | undefined {
        return AsyncLocal.Context as Tx;
    }

    protected abstract beginTransaction(): Promise<Tx>;

    protected abstract commitTransaction(tx: Tx): Promise<void>;

    protected abstract rollbackTransaction(tx: Tx): Promise<void>;

    private async executeNewTransaction<ReturnType extends any>(
        callback: (tx: Tx) => Promise<ReturnType>
    ): Promise<any> {
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
    }

    public async executeTransaction<ReturnType extends any>(
        propagation: Propagation = Propagation.REQUIRED,
        callback: (tx: Tx) => Promise<ReturnType>,
    ): Promise<any> {
        const existingTx = this.getCurrentTransaction();

        switch (propagation) {
            case Propagation.REQUIRES_NEW:
                // 무조건 신규 트랜잭션을 시작합니다.
                return this.executeNewTransaction(callback);

            case Propagation.REQUIRED:
                // 기존 트랜잭션이 있으면 재사용, 없으면 신규 트랜잭션을 시작합니다.
                return existingTx ? callback(existingTx) : this.executeNewTransaction(callback);

            case Propagation.MANDATORY:
                if (!existingTx) {
                    // 기존 트랜잭션이 없으면 예외를 던집니다.
                    throw new IllegalTransactionStateException(propagation);
                }
                return callback(existingTx);

            // case Propagation.SUPPORTS:
            //     // 기존 트랜잭션이 있을 경우만 콜백을 실행합니다.
            //     if (existingTx) {
            //         return callback(existingTx);
            //     }
            //     // 기존 트랜잭션이 없을 경우 동작 정의가 없으므로 오류 처리합니다.
            //     throw new Error("Not implemented");
            //
            // case Propagation.NOT_SUPPORTED:
            //     // 트랜잭션 없이 실행해야 하는 경우 (구현 필요)
            //     throw new Error("Not implemented");
            //
            // case Propagation.NEVER:
            //     if (existingTx) {
            //         // 트랜잭션이 존재하면 예외를 던집니다.
            //         throw new IllegalTransactionStateException(propagation);
            //     }
            //     // 트랜잭션이 없을 경우 실행 (구현 필요)
            //     throw new Error("Not implemented");

            default:
                throw new UnsupportedTransactionPropagationException();
        }
    }
}