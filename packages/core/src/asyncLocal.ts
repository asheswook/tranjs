import { MetadataWrappedTransaction, TransactionContext } from "./context";
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PlatformTransactionManager } from "./manager";
import type { TransactionGate } from "./internal";

export type TransactionSynchronization = () => void | Promise<void>;

/** Internal state shared only by scopes of the same physical transaction. */
export interface TxState {
    context: MetadataWrappedTransaction<TransactionContext>;
    active: boolean;
    gate?: TransactionGate;
    rollbackOnly: boolean;
    deadline?: number;
    timeout?: number;
    savepointCounter: number;
    afterCommit: TransactionSynchronization[];
    afterRollback: TransactionSynchronization[];
    /** Set once, in the step that clears `active` and before any hook runs. `failed`: COMMIT or ROLLBACK threw. */
    outcome?: "committed" | "rolled-back" | "failed";
}

/** Per-parent scope guard; distinct recursive scopes share the physical TxState. */
export interface TransactionScope {
    nestedOpen: boolean;
    /** NESTED scopes only: hooks wait here until the savepoint is released or rolled back. */
    hooks?: Pick<TxState, "afterCommit" | "afterRollback">;
    /** NESTED scopes only: the scope that was open when this one began. */
    parent?: TransactionScope;
    /** NESTED scopes only: `released` covers every exit that did not roll back to the savepoint. */
    outcome?: "released" | "rolled-back";
}

export interface TransactionFrame {
    txs: Map<PlatformTransactionManager<any>, TxState | null>;
    scopes?: Map<PlatformTransactionManager<any>, TransactionScope | null>;
    current?: MetadataWrappedTransaction<TransactionContext>;
}

export class AsyncLocal {
    private static storage = new AsyncLocalStorage<TransactionFrame>();

    // static class
    private constructor() {}

    static get Context() {
        const frame = AsyncLocal.Frame;
        if (!frame) return undefined;
        const states = Array.from(frame.txs.values());
        const currentState = states.find(state => state?.context === frame.current);
        if (!currentState || currentState.active) return frame.current;
        return states.reverse().find(state => state?.active)?.context;
    }

    static get Frame(): TransactionFrame | undefined {
        return AsyncLocal.storage.getStore();
    }

    static RunFrame<T>(frame: TransactionFrame, callback: () => T): T {
        return AsyncLocal.storage.run({ ...frame, txs: new Map(frame.txs) }, callback);
    }

    static Run<T>(context: MetadataWrappedTransaction<TransactionContext>, callback: () => T): T {
        return AsyncLocal.RunFrame({ txs: new Map(AsyncLocal.Frame?.txs), current: context }, callback);
    }
}
