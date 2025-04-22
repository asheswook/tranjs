import { MetadataWrappedTransaction, TransactionContext } from "./context";
import { AsyncLocalStorage } from 'node:async_hooks';

export class AsyncLocal {
    private static storage = new AsyncLocalStorage<MetadataWrappedTransaction<TransactionContext>>();

    // static class
    private constructor() {}

    static get Context() {
        return AsyncLocal.storage.getStore();
    }

    static Run<T>(context: MetadataWrappedTransaction<TransactionContext>, callback: () => T): T {
        return AsyncLocal.storage.run(context, callback);
    }
}