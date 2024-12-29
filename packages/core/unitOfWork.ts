import { AsyncLocalStorage } from 'node:async_hooks';

export interface TransactionContext {}

export abstract class AbstractUnitOfWork<Tx extends TransactionContext> {
    abstract beginTransaction(): Promise<Tx>;
    abstract commitTransaction(tx: Tx): Promise<void>;
    abstract rollbackTransaction(tx: Tx): Promise<void>;
}