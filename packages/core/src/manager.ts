import { MetadataWrappedTransaction, TransactionContext } from "./context";
import { Propagation } from "./propagation";
import { AsyncLocal, TransactionSynchronization, TxState } from "./asyncLocal";
import { DEFAULT_DATASOURCE, TransactionConfig, TransactionOptions } from "./config";
import { DatasourceSetupError, IllegalTransactionStateException, NestedTransactionNotSupportedError,
    NoTransactionContextError, TransactionTimeoutError, UnsupportedTransactionPropagationException } from "./error";
import { DefaultLogger, Logger } from "./logger";

const managers = new Map<string | symbol, PlatformTransactionManager<any>>();

/** @deprecated Resolve a datasource with getTransactionManager() instead. */
export let GlobalTransactionManager: PlatformTransactionManager<TransactionContext>;

/** @deprecated Use the type-safe ctx() exported by your driver instead. */
export function ctx<Tx extends TransactionContext>(): Tx {
    const context = AsyncLocal.Context;
    if (!context) throw new NoTransactionContextError();
    return context.transaction as Tx;
}

export function useTransactionManager<Tx extends TransactionContext>(
    transactionManager: PlatformTransactionManager<Tx>,
    name: string | symbol = DEFAULT_DATASOURCE,
): void {
    if (transactionManager) managers.set(name, transactionManager);
    else managers.delete(name);
    if (name === DEFAULT_DATASOURCE) GlobalTransactionManager = transactionManager;
}

export function getTransactionManager(name: string | symbol = DEFAULT_DATASOURCE): PlatformTransactionManager<any> {
    const manager = managers.get(name);
    if (!manager) throw new DatasourceSetupError(name);
    return manager;
}

export function runInTransaction<T>(fn: () => Promise<T> | T, config: TransactionConfig = {}): Promise<T> {
    const { propagation = Propagation.REQUIRED, datasource, ...options } = config;
    // Resolve inside an async call so setup errors are Promise rejections, too.
    return (async () => getTransactionManager(datasource).executeTransaction(propagation, fn, options))();
}

/** Register on the physical transaction; without an active transaction, run immediately. */
export function afterCommit(fn: TransactionSynchronization, datasource: string | symbol = DEFAULT_DATASOURCE): void | Promise<void> {
    const state = AsyncLocal.Frame?.txs.get(managers.get(datasource)!);
    if (state?.active) state.afterCommit.push(fn);
    else return fn();
}

/** Register on the physical transaction (including NESTED scopes); without one, ignore. */
export function afterRollback(fn: TransactionSynchronization, datasource: string | symbol = DEFAULT_DATASOURCE): void {
    const state = AsyncLocal.Frame?.txs.get(managers.get(datasource)!);
    if (state?.active) state.afterRollback.push(fn);
}

export abstract class PlatformTransactionManager<Tx extends TransactionContext> {
    protected constructor(private logger: Logger = new DefaultLogger()) {}

    setLogger(logger: Logger): void {
        this.logger = logger;
    }

    getCurrentTransaction(): Tx | undefined {
        const state = this.currentState();
        return state?.context.transaction as Tx | undefined;
    }

    private currentState(): TxState | undefined {
        const state = AsyncLocal.Frame?.txs.get(this);
        return state?.active ? state : undefined;
    }

    protected abstract beginTransaction(options?: TransactionOptions): Promise<MetadataWrappedTransaction<Tx>>;
    protected abstract commitTransaction(tx: Tx): Promise<void>;
    protected abstract rollbackTransaction(tx: Tx): Promise<void>;

    protected async createSavepoint(tx: Tx, name: string): Promise<void> {
        throw new NestedTransactionNotSupportedError();
    }

    protected async rollbackToSavepoint(tx: Tx, name: string): Promise<void> {
        throw new NestedTransactionNotSupportedError();
    }

    protected async releaseSavepoint(tx: Tx, name: string): Promise<void> {
        throw new NestedTransactionNotSupportedError();
    }

    private inScope<R>(state: TxState | null, callback: () => R): R {
        const txs = new Map(AsyncLocal.Frame?.txs);
        // Map order records the most recently entered manager scope.
        txs.delete(this);
        txs.set(this, state);
        const current = Array.from(txs.values()).reverse().find(tx => tx?.active)?.context;
        return AsyncLocal.RunFrame({ txs, current }, callback);
    }

    private logError(message: string, error: unknown): void {
        // Even a custom logger must not replace the original transaction error.
        try { this.logger.error(message, error); } catch {}
    }

    private async synchronize(hooks: TransactionSynchronization[]): Promise<void> {
        for (const hook of hooks) {
            try { await hook(); }
            catch (error) { this.logError("Transaction synchronization failed", error); }
        }
    }

    private async rollback(state: TxState): Promise<void> {
        try { await this.rollbackTransaction(state.context.transaction as Tx); }
        catch (error) { this.logError("Transaction rollback failed", error); }
        finally { state.active = false; }
        await this.inScope(null, () => this.synchronize(state.afterRollback));
    }

    private executeNewTransaction<R>(callback: (tx: Tx) => Promise<R> | R, options?: TransactionOptions): Promise<R> {
        // Suspend before begin, too, so driver hooks cannot observe the outer tx.
        return this.inScope(null, async () => {
            const started = Date.now();
            const context = await this.beginTransaction(options);
            const state: TxState = { context, active: true, savepointCounter: 0, afterCommit: [], afterRollback: [] };
            return this.inScope(state, async () => {
                let result: R;
                try { result = await callback(context.transaction as Tx); }
                catch (error) {
                    await this.rollback(state);
                    throw error;
                }
                if (options?.timeout !== undefined && Date.now() - started > options.timeout) {
                    const error = new TransactionTimeoutError(options.timeout);
                    await this.rollback(state);
                    throw error;
                }
                // Commit failures belong to the driver: never issue a second rollback.
                try { await this.commitTransaction(context.transaction as Tx); }
                finally { state.active = false; }
                await this.inScope(null, () => this.synchronize(state.afterCommit));
                return result;
            });
        });
    }

    private executeNested<R>(state: TxState, callback: (tx: Tx) => R | Promise<R>): Promise<R> {
        return this.inScope(state, async () => {
            const tx = state.context.transaction as Tx;
            const name = `tranjs_sp_${++state.savepointCounter}`;
            await this.createSavepoint(tx, name);
            let result: R;
            try { result = await callback(tx); }
            catch (error) {
                try { await this.rollbackToSavepoint(tx, name); }
                catch (rollbackError) { this.logError("Savepoint rollback failed", rollbackError); }
                throw error;
            }
            await this.releaseSavepoint(tx, name);
            return result;
        });
    }

    public async executeTransaction<R>(
        propagation: Propagation = Propagation.REQUIRED,
        callback: (tx: Tx) => R | Promise<R>,
        options?: TransactionOptions,
    ): Promise<R> {
        const state = this.currentState();
        const join = () => this.inScope(state!, () => callback(state!.context.transaction as Tx));
        const withoutTransaction = () => this.inScope(null, () => callback(undefined as unknown as Tx));
        switch (propagation) {
            case Propagation.REQUIRES_NEW:
                return this.executeNewTransaction(callback, options);
            case Propagation.REQUIRED:
                return state ? join() : this.executeNewTransaction(callback, options);
            case Propagation.MANDATORY:
                if (!state) throw new IllegalTransactionStateException(propagation);
                return join();
            case Propagation.SUPPORTS:
                return state ? join() : withoutTransaction();
            case Propagation.NOT_SUPPORTED:
                return withoutTransaction();
            case Propagation.NEVER:
                if (state) throw new IllegalTransactionStateException(propagation);
                return withoutTransaction();
            case Propagation.NESTED:
                return state ? this.executeNested(state, callback) : this.executeNewTransaction(callback, options);
            default:
                throw new UnsupportedTransactionPropagationException();
        }
    }
}
