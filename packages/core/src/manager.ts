import { MetadataWrappedTransaction, TransactionContext } from "./context";
import { Propagation } from "./propagation";
import { AsyncLocal, TransactionSynchronization, TxState } from "./asyncLocal";
import { DEFAULT_DATASOURCE, IsolationLevel, TransactionConfig, TransactionOptions } from "./config";
import { DatasourceSetupError, IllegalTransactionStateException, NestedTransactionNotSupportedError,
    NoTransactionContextError, TransactionTimeoutError, UnsupportedTransactionPropagationException,
    ConcurrentNestedTransactionError, InvalidIsolationLevelError, UnexpectedRollbackError, TransactionSystemError } from "./error";
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

    /** Called once after completion; failed means COMMIT or ROLLBACK threw. */
    protected async releaseTransaction(tx: Tx, failed: boolean): Promise<void> {}

    protected getRemainingTimeout(): number | undefined {
        const state = this.currentState();
        if (state?.deadline === undefined) return undefined;
        const remaining = state.deadline - Date.now();
        if (remaining <= 0) {
            state.rollbackOnly = true;
            throw new TransactionTimeoutError(state.timeout!);
        }
        return remaining;
    }

    /**
     * Drivers call this when a per-query timeout derived from the transaction deadline fires.
     * Timers may fire marginally before Date.now() reaches the deadline, so this does not re-check the clock.
     */
    protected expireTransaction(): TransactionTimeoutError | undefined {
        const state = this.currentState();
        if (state?.deadline === undefined) return undefined;
        state.rollbackOnly = true;
        return new TransactionTimeoutError(state.timeout!);
    }

    protected async createSavepoint(tx: Tx, name: string): Promise<void> {
        throw new NestedTransactionNotSupportedError();
    }

    protected async rollbackToSavepoint(tx: Tx, name: string): Promise<void> {
        throw new NestedTransactionNotSupportedError();
    }

    protected async releaseSavepoint(tx: Tx, name: string): Promise<void> {
        throw new NestedTransactionNotSupportedError();
    }

    private inScope<R>(state: TxState | null, callback: () => R, newScope = false): R {
        const txs = new Map(AsyncLocal.Frame?.txs);
        const scopes = new Map(AsyncLocal.Frame?.scopes);
        if (!state) scopes.set(this, null);
        else if (newScope || txs.get(this) !== state || !scopes.get(this)) {
            scopes.set(this, { nestedOpen: false });
        }
        // Map order records the most recently entered manager scope.
        txs.delete(this);
        txs.set(this, state);
        const current = Array.from(txs.values()).reverse().find(tx => tx?.active)?.context;
        return AsyncLocal.RunFrame({ txs, scopes, current }, callback);
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

    private async rollback(state: TxState, applicationError: unknown): Promise<void> {
        try { await this.rollbackTransaction(state.context.transaction as Tx); }
        catch (error) {
            this.logError("Transaction application error before rollback failure", applicationError);
            throw new TransactionSystemError(error, applicationError);
        }
        finally {
            state.active = false;
            await this.inScope(null, () => this.synchronize(state.afterRollback));
        }
    }

    private executeNewTransaction<R>(callback: (tx: Tx) => Promise<R> | R, options?: TransactionOptions): Promise<R> {
        // Suspend before begin, too, so driver hooks cannot observe the outer tx.
        return this.inScope(null, async () => {
            if (options?.isolationLevel !== undefined && !Object.values(IsolationLevel).includes(options.isolationLevel)) {
                throw new InvalidIsolationLevelError(options.isolationLevel);
            }
            if (options?.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout < 0)) {
                throw new RangeError("Transaction timeout must be a non-negative finite number");
            }
            const started = Date.now();
            const context = await this.beginTransaction(options);
            const state: TxState = {
                context, active: true, rollbackOnly: false, savepointCounter: 0, afterCommit: [], afterRollback: [],
                timeout: options?.timeout,
                deadline: options?.timeout === undefined ? undefined : started + options.timeout,
            };
            return this.inScope(state, async () => {
                let failed = false;
                try {
                    let result: R;
                    try {
                        result = await callback(context.transaction as Tx);
                        this.getRemainingTimeout();
                        if (state.rollbackOnly) throw new UnexpectedRollbackError();
                    } catch (error) {
                        try { await this.rollback(state, error); }
                        catch (rollbackError) { failed = true; throw rollbackError; }
                        throw error;
                    }
                    try { await this.commitTransaction(context.transaction as Tx); }
                    catch (error) {
                        failed = true;
                        state.active = false;
                        await this.inScope(null, () => this.synchronize(state.afterRollback));
                        throw error;
                    }
                    state.active = false;
                    await this.inScope(null, () => this.synchronize(state.afterCommit));
                    return result;
                } finally {
                    state.active = false;
                    await this.releaseTransaction(context.transaction as Tx, failed);
                }
            });
        });
    }

    private executeNested<R>(state: TxState, callback: (tx: Tx) => R | Promise<R>): Promise<R> {
        const parent = AsyncLocal.Frame!.scopes!.get(this)!;
        if (parent.nestedOpen) return Promise.reject(new ConcurrentNestedTransactionError());
        parent.nestedOpen = true;
        return this.inScope(state, async () => {
            try {
                const tx = state.context.transaction as Tx;
                const name = `tranjs_sp_${++state.savepointCounter}`;
                await this.createSavepoint(tx, name);
                let result: R;
                try { result = await callback(tx); }
                catch (error) {
                    try { await this.rollbackToSavepoint(tx, name); }
                    catch (rollbackError) {
                        state.rollbackOnly = true;
                        this.logError("Savepoint rollback failed", rollbackError);
                    }
                    throw error;
                }
                await this.releaseSavepoint(tx, name);
                return result;
            } finally { parent.nestedOpen = false; }
        }, true);
    }

    public async executeTransaction<R>(
        propagation: Propagation = Propagation.REQUIRED,
        callback: (tx: Tx) => R | Promise<R>,
        options?: TransactionOptions,
    ): Promise<R> {
        const state = this.currentState();
        const join = () => this.inScope(state!, async () => {
            try { return await callback(state!.context.transaction as Tx); }
            catch (error) {
                state!.rollbackOnly = true;
                throw error;
            }
        });
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
