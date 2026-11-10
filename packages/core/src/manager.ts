import { MetadataWrappedTransaction, TransactionContext } from "./context";
import { Propagation } from "./propagation";
import { AsyncLocal, TransactionSynchronization, TxState } from "./asyncLocal";
import { DEFAULT_DATASOURCE, IsolationLevel, TransactionConfig, TransactionOptions } from "./config";
import { DatasourceSetupError, IllegalTransactionStateException, NestedTransactionNotSupportedError,
    NoTransactionContextError, TransactionTimeoutError, UnsupportedTransactionPropagationException,
    ConcurrentNestedTransactionError, InvalidIsolationLevelError, UnexpectedRollbackError, TransactionSystemError } from "./error";
import { DefaultLogger, Logger } from "./logger";
import { assertTestSessionReady, currentTestSession, testAccess, testScope, testSession, TestBoundaryInfo, FixtureLease, runTestProvenance, testProvenance } from "./internal";

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
    if (!transactionManager) return clearTransactionManager(name);
    managers.set(name, transactionManager);
    if (name === DEFAULT_DATASOURCE) GlobalTransactionManager = transactionManager;
}

/** Remove a registration without changing transactions already in progress. */
export function clearTransactionManager(name: string | symbol = DEFAULT_DATASOURCE): void {
    managers.delete(name);
    // The deprecated global keeps its original non-optional type for compatibility;
    // at runtime it is empty until a default manager is registered.
    if (name === DEFAULT_DATASOURCE) GlobalTransactionManager = undefined as unknown as PlatformTransactionManager<TransactionContext>;
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
    else return runTestProvenance("hook", fn);
}

/** Register on the physical transaction (including NESTED scopes); without one, ignore. */
export function afterRollback(fn: TransactionSynchronization, datasource: string | symbol = DEFAULT_DATASOURCE): void {
    const state = AsyncLocal.Frame?.txs.get(managers.get(datasource)!);
    if (state?.active) state.afterRollback.push(fn);
}

export abstract class PlatformTransactionManager<Tx extends TransactionContext> {
    protected constructor(private logger: Logger = new DefaultLogger()) {
        testAccess.set(this, {
            begin: options => this.beginTransaction(options),
            rollback: tx => this.rollbackTransaction(tx),
            release: (tx, failed) => this.releaseTransaction(tx, failed),
            outside: fn => this.inScope(null, fn),
            logError: (message, error) => this.logError(message, error),
            fixtureConnection: (tx, lease) => this.createFixtureConnection(tx, lease),
            createSavepoint: (tx, name) => this.createSavepoint(tx, name),
            rollbackToSavepoint: (tx, name) => this.rollbackToSavepoint(tx, name),
            releaseSavepoint: (tx, name) => this.releaseSavepoint(tx, name),
        });
    }

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

    /** Internal optional capability implemented by driver-owned fixture adapters. */
    protected createFixtureConnection(tx: Tx, lease: FixtureLease): unknown {
        throw new Error("This transaction manager does not support fixture connections");
    }

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

    /** Internal testing hook; production owners never call this. */
    protected async checkTestTransactionConstraints(tx: Tx, name: string): Promise<void> {}

    private async checkTestConstraints(tx: Tx): Promise<void> {
        const session = testSession(this);
        if (session?.context) {
            await this.checkTestTransactionConstraints(tx, `tranjs_sp_${++session.counter}`);
        }
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

    private async rollback(state: TxState, failure: { error: unknown }, info?: TestBoundaryInfo, savepoint?: string): Promise<void> {
        const session = testSession(this);
        try {
            // Even an injected rollback failure must not leave test writes behind.
            let injected: unknown;
            let hasInjected = false;
            try { if (info) session!.fail("rollback", info); }
            catch (error) { injected = error; hasInjected = true; }
            if (savepoint) await this.recoverTestSavepoint(state.context.transaction as Tx, savepoint);
            else await this.rollbackTransaction(state.context.transaction as Tx);
            if (hasInjected) throw injected;
        }
        catch (error) {
            this.logError("Transaction application error before rollback failure", failure.error);
            const rollbackError = new TransactionSystemError(error, failure.error);
            // Final test cleanup must retain both failures even if the caller catches this one.
            if (savepoint && session && "broken" in session && session.broken === error) session.broken = rollbackError;
            throw rollbackError;
        }
        finally {
            if (info) session!.complete(info, "rolled-back");
            state.active = false;
            await this.inScope(null, () => this.synchronize(state.afterRollback));
        }
    }

    /** Drivers may preserve their own public aborted-transaction error type. */
    protected testTransactionAbortedError(cause: unknown): Error {
        const error = new Error("PostgreSQL test transaction scope was aborted; savepoint commit failed and the scope was rolled back");
        error.name = "TestTransactionAbortedError";
        Object.assign(error, { cause, code: "25P02" });
        return error;
    }

    private async recoverTestSavepoint(tx: Tx, name: string): Promise<void> {
        try {
            await this.rollbackToSavepoint(tx, name);
            await this.releaseSavepoint(tx, name);
        } catch (error) {
            testSession(this)!.broken = error;
            throw error;
        }
    }

    private executeNewTransaction<R>(callback: (tx: Tx) => Promise<R> | R, options: TransactionOptions | undefined, propagation: Propagation): Promise<R> {
        const parent = this.currentState();
        const session = testSession(this);
        // Suspend before begin, too, so driver hooks cannot observe the outer tx.
        return testScope(this, () => this.inScope(null, async () => {
            if (options?.isolationLevel !== undefined && !Object.values(IsolationLevel).includes(options.isolationLevel)) {
                throw new InvalidIsolationLevelError(options.isolationLevel);
            }
            if (options?.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout < 0 || options.timeout > 2147483647)) {
                throw new RangeError("Transaction timeout must be a finite number between 0 and 2147483647 milliseconds");
            }
            const started = Date.now();
            const info = session?.begin(options ?? {}, propagation, parent);
            const savepoint = session?.context ? `tranjs_sp_${++session.counter}` : undefined;
            let context: MetadataWrappedTransaction<Tx>;
            try {
                if (info) session!.fail("begin", info);
                if (savepoint) {
                    context = session!.context!;
                    await this.createSavepoint(context.transaction, savepoint);
                } else context = await this.beginTransaction(options);
            } catch (error) {
                if (info) session!.complete(info, "rolled-back");
                throw error;
            }
            const state: TxState = {
                context, active: true, rollbackOnly: false, savepointCounter: 0, afterCommit: [], afterRollback: [],
                timeout: options?.timeout,
                deadline: options?.timeout === undefined ? undefined : started + options.timeout,
            };
            if (info) session!.attach(state, info);
            return this.inScope(state, async () => {
                let failed = false;
                try {
                    let result: R;
                    try {
                        result = await callback(context.transaction as Tx);
                        this.getRemainingTimeout();
                        if (state.rollbackOnly) throw new UnexpectedRollbackError();
                    } catch (error) {
                        try { await this.rollback(state, { error }, info, savepoint); }
                        catch (rollbackError) { failed = true; throw rollbackError; }
                        throw error;
                    }
                    try {
                        if (info) session!.fail("commit", info);
                        if (savepoint) {
                            await this.checkTestConstraints(context.transaction as Tx);
                            await this.releaseSavepoint(context.transaction as Tx, savepoint);
                        }
                        else await this.commitTransaction(context.transaction as Tx);
                    }
                    catch (error) {
                        failed = true;
                        if (info) {
                            // Recovery is a real logical rollback: consume its
                            // selector, contain native writes, and combine errors.
                            await this.rollback(state, { error }, info, savepoint);
                        } else {
                            state.active = false;
                            await this.inScope(null, () => this.synchronize(state.afterRollback));
                        }
                        if (savepoint && (error as { code?: string })?.code === "25P02") throw this.testTransactionAbortedError(error);
                        throw error;
                    }
                    if (info) session!.complete(info, "committed");
                    state.active = false;
                    await this.inScope(null, async () => {
                        for (const hook of state.afterCommit) {
                            // Only a live test session captures callback provenance.
                            // The production path neither creates nor loads evidence.
                            if (session) await session.runAfterCommit(state, hook);
                            else await hook();
                        }
                    });
                    return result;
                } finally {
                    state.active = false;
                    if (!savepoint) await this.releaseTransaction(context.transaction as Tx, failed);
                }
            });
        }));
    }

    private executeNested<R>(state: TxState, callback: (tx: Tx) => R | Promise<R>): Promise<R> {
        return testScope(this, () => {
            const parent = AsyncLocal.Frame!.scopes!.get(this)!;
            if (parent.nestedOpen) return Promise.reject(new ConcurrentNestedTransactionError());
            parent.nestedOpen = true;
            return this.inScope(state, async () => {
                try {
                    const tx = state.context.transaction as Tx;
                    const session = testSession(this);
                    const name = `tranjs_sp_${session?.context ? ++session.counter : ++state.savepointCounter}`;
                    await this.createSavepoint(tx, name);
                    let result: R;
                    try {
                        result = await callback(tx);
                        if (state.rollbackOnly) throw new UnexpectedRollbackError();
                        if (session?.context) await this.checkTestConstraints(tx);
                    }
                    catch (error) {
                        try {
                            await this.rollbackToSavepoint(tx, name);
                            // Spring resets the entire connection flag, including pre-existing rollback-only.
                            state.rollbackOnly = false;
                        }
                        catch (rollbackError) {
                            state.rollbackOnly = true;
                            this.logError("Savepoint rollback failed", rollbackError);
                            if (session?.context) {
                                const failure = new TransactionSystemError(rollbackError, error);
                                session.broken = failure;
                                throw failure;
                            }
                        }
                        throw error;
                    }
                    await this.releaseSavepoint(tx, name);
                    return result;
                } finally { parent.nestedOpen = false; }
            }, true);
        });
    }

    public async executeTransaction<R>(
        propagation: Propagation = Propagation.REQUIRED,
        callback: (tx: Tx) => R | Promise<R>,
        options?: TransactionOptions,
    ): Promise<R> {
        if (testProvenance() === "fixture") throw new Error("Managed transaction entry is forbidden inside a fixture callback");
        const current = currentTestSession();
        if (current?.fixtureActive) throw new Error("Managed transaction entry overlaps an active fixture");
        const session = testSession(this);
        if (session) assertTestSessionReady(session);
        if (session && !session.admitting) throw new Error("Test session no longer admits managed work");
        // A mock's registration may already be restored to another manager, but
        // work retained by that closed session must not enter a real transaction.
        const currentSession = currentTestSession();
        if (currentSession && currentSession !== session && (currentSession.closed || "broken" in currentSession)) {
            assertTestSessionReady(currentSession);
        }
        if (session) session.managedActive++;
        try {
            return await runTestProvenance("managed", () => this.dispatchTransaction(propagation, callback, options));
        } finally { if (session) session.managedActive--; }
    }

    private async dispatchTransaction<R>(propagation: Propagation, callback: (tx: Tx) => R | Promise<R>, options?: TransactionOptions): Promise<R> {
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
                return this.executeNewTransaction(callback, options, propagation);
            case Propagation.REQUIRED:
                return state ? join() : this.executeNewTransaction(callback, options, propagation);
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
                return state ? this.executeNested(state, callback) : this.executeNewTransaction(callback, options, propagation);
            default:
                throw new UnsupportedTransactionPropagationException();
        }
    }
}
