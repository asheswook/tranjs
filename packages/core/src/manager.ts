import { MetadataWrappedTransaction, TransactionContext } from "./context";
import { Propagation } from "./propagation";
import { AsyncLocal, TransactionSynchronization, TxState } from "./asyncLocal";
import { DEFAULT_DATASOURCE, IsolationLevel, TransactionConfig, TransactionOptions } from "./config";
import { DatasourceSetupError, IllegalTransactionStateException, NestedTransactionNotSupportedError,
    NoTransactionContextError, TransactionTimeoutError, UnsupportedTransactionPropagationException,
    ConcurrentNestedTransactionError, InvalidIsolationLevelError, UnexpectedRollbackError, TransactionSystemError, TransactionClosedError } from "./error";
import { DefaultLogger, Logger } from "./logger";
import { assertTestSessionReady, currentTestSession, testAccess, testScope, testSession, TestBoundaryInfo, TestConnectionLease, runTestProvenance, testProvenance, TransactionGate, assertConnectionOpen } from "./internal";

const managers = new Map<string | symbol, PlatformTransactionManager<any>>();

/** @deprecated Resolve a datasource with getTransactionManager() instead. */
export let GlobalTransactionManager: PlatformTransactionManager<TransactionContext>;

/** @deprecated Use the type-safe ctx() exported by your driver instead. */
export function ctx<Tx extends TransactionContext>(): Tx {
    const retained = Array.from(AsyncLocal.Frame?.txs.values() ?? []).reverse().find(state => state !== null);
    if (retained) {
        if (!retained.active) throw new TransactionClosedError();
        if (retained.gate) assertConnectionOpen(retained.gate);
    }
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

/** Internal driver lookup. A retained closed scope cannot select an outer connection. */
export function resolveContextManager(datasource?: string | symbol): PlatformTransactionManager<any> {
    if (datasource !== undefined) return getTransactionManager(datasource);
    for (const [manager, state] of Array.from(AsyncLocal.Frame?.txs ?? []).reverse()) {
        if (!state) continue;
        manager.assertCurrentTransactionOpen();
        return manager;
    }
    return getTransactionManager();
}

export function runInTransaction<T>(fn: () => Promise<T> | T, config: TransactionConfig = {}): Promise<T> {
    const { propagation = Propagation.REQUIRED, datasource, ...options } = config;
    // Resolve inside an async call so setup errors are Promise rejections, too.
    return (async () => getTransactionManager(datasource).executeTransaction(propagation, fn, options))();
}

/** Wrap a function in a managed transaction, resolving its datasource on each invocation. */
export function transactional<This, Args extends unknown[], R>(
    fn: (this: This, ...args: Args) => R, config: Propagation | TransactionConfig = Propagation.REQUIRED,
): (this: This, ...args: Args) => Promise<Awaited<R>> {
    const snapshot = typeof config === "string" ? { propagation: config } : { ...config };
    return function(this: This, ...args: Args): Promise<Awaited<R>> {
        return runInTransaction(() => fn.apply(this, args), snapshot) as Promise<Awaited<R>>;
    };
}

function synchronizationState(datasource?: string | symbol): TxState | undefined {
    const frame = AsyncLocal.Frame;
    if (datasource !== undefined) return frame?.txs.get(managers.get(datasource)!) ?? undefined;
    const context = AsyncLocal.Context;
    return Array.from(frame?.txs.values() ?? []).find(state => state?.active && state.context === context) ?? undefined;
}

/** Register on the selected transaction, or the innermost active one when no datasource is given. */
export function afterCommit(fn: TransactionSynchronization, datasource?: string | symbol): void | Promise<void> {
    const state = synchronizationState(datasource);
    if (state?.active) state.afterCommit.push(fn);
    else return runTestProvenance("hook", fn);
}

/** Register on the physical transaction (including NESTED scopes); without one, ignore. */
export function afterRollback(fn: TransactionSynchronization, datasource?: string | symbol): void {
    const state = synchronizationState(datasource);
    if (state?.active) state.afterRollback.push(fn);
}

export abstract class PlatformTransactionManager<Tx extends TransactionContext> {
    private readonly connectionGates = new WeakMap<object, TransactionGate>();

    private newConnectionGate(tx: Tx): TransactionGate {
        const gate: TransactionGate = { closed: false };
        if ((typeof tx === "object" && tx !== null) || typeof tx === "function") this.connectionGates.set(tx as object, gate);
        return gate;
    }

    /** A wrapper captures this object so a later checkout cannot reopen it. */
    protected getConnectionGate(tx: Tx): TransactionGate {
        const state = AsyncLocal.Frame?.txs.get(this);
        if (state?.context.transaction === tx && state.gate) return state.gate;
        const session = testSession(this);
        if (session?.context?.transaction === tx && session.connectionGate) return session.connectionGate;
        return this.connectionGates.get(tx as object) ?? this.newConnectionGate(tx);
    }

    protected assertConnectionOpen(gate: TransactionGate): void { assertConnectionOpen(gate); }

    protected assertTransactionConnectionOpen(tx: Tx): void {
        this.assertConnectionOpen(this.getConnectionGate(tx));
    }

    protected constructor(private logger: Logger = new DefaultLogger()) {
        testAccess.set(this, {
            begin: async options => {
                const context = await this.beginTransaction(options);
                this.newConnectionGate(context.transaction as Tx);
                return context;
            },
            gate: tx => this.getConnectionGate(tx),
            close: tx => { (testSession(this)?.connectionGate ?? this.getConnectionGate(tx)).closed = true; },
            rollback: tx => this.rollbackTransaction(tx),
            release: (tx, failed) => this.releaseTransaction(tx, failed),
            outside: fn => this.inScope(null, fn),
            logError: (message, error) => this.logError(message, error),
            testConnection: (tx, lease) => this.createTestConnection(tx, lease),
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

    /** Driver ctx() lookups check the retained scope before returning a handle. */
    assertCurrentTransactionOpen(): void {
        const state = AsyncLocal.Frame?.txs.get(this);
        if (!state) return;
        if (!state.active) throw new TransactionClosedError();
        if (state.gate) this.assertConnectionOpen(state.gate);
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

    /** Internal optional capability implemented by driver-owned withTestConnection adapters. */
    protected createTestConnection(tx: Tx, lease: TestConnectionLease): unknown {
        throw new Error("This transaction manager does not support withTestConnection");
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
            await this.checkTestTransactionConstraints(tx, `tranjs_${session.id}_sp_${++session.counter}`);
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
        if (savepoint && session?.connectionGate?.closed) {
            if (state.gate) state.gate.closed = true;
            state.active = false;
            throw new TransactionClosedError();
        }
        if (state.gate) state.gate.closed = true;
        try {
            // Even an injected rollback failure must not leave test writes behind.
            let injected: unknown;
            let hasInjected = false;
            try { if (info) session!.failNext("rollback", info); }
            catch (error) { injected = error; hasInjected = true; }
            if (savepoint) await this.inScope(null, () => this.recoverTestSavepoint(state.context.transaction as Tx, savepoint));
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

    /** Drivers may normalize savepoint completion failures to their public commit errors. */
    protected testTransactionCommitError(cause: unknown): unknown {
        return cause;
    }

    private async recoverTestSavepoint(tx: Tx, name: string): Promise<void> {
        try {
            await this.rollbackToSavepoint(tx, name);
            await this.releaseSavepoint(tx, name);
        } catch (error) {
            if (testSession(this)?.closed) throw new TransactionClosedError();
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
            const savepoint = session?.context ? `tranjs_${session.id}_sp_${++session.counter}` : undefined;
            let context: MetadataWrappedTransaction<Tx>;
            try {
                if (info) session!.failNext("begin", info);
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
                gate: savepoint ? { closed: false, parent: session!.connectionGate } : this.newConnectionGate(context.transaction as Tx),
                timeout: options?.timeout,
                deadline: options?.timeout === undefined ? undefined : started + options.timeout,
            };
            if (info) session!.attach(state, info);
            return this.inScope(state, async () => {
                let failed = false;
                try {
                    let result: R;
                    try {
                        this.assertConnectionOpen(state.gate!);
                        result = await callback(context.transaction as Tx);
                        this.assertConnectionOpen(state.gate!);
                        this.getRemainingTimeout();
                        if (state.rollbackOnly) throw new UnexpectedRollbackError();
                    } catch (error) {
                        try { await this.rollback(state, { error }, info, savepoint); }
                        catch (rollbackError) { failed = true; throw rollbackError; }
                        throw error;
                    }
                    try {
                        state.gate!.closed = true;
                        if (info) session!.failNext("commit", info);
                        if (savepoint) {
                            await this.inScope(null, async () => {
                                await this.checkTestConstraints(context.transaction as Tx);
                                await this.releaseSavepoint(context.transaction as Tx, savepoint);
                            });
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
                        if (savepoint) throw this.testTransactionCommitError(error);
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
                    state.gate!.closed = true;
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
                    const name = session?.context ? `tranjs_${session.id}_sp_${++session.counter}` : `tranjs_sp_${++state.savepointCounter}`;
                    await this.createSavepoint(tx, name);
                    let result: R;
                    try {
                        result = await callback(tx);
                        if (state.gate) this.assertConnectionOpen(state.gate);
                        if (state.rollbackOnly) throw new UnexpectedRollbackError();
                        if (session?.context) await this.checkTestConstraints(tx);
                    }
                    catch (error) {
                        if (state.gate) this.assertConnectionOpen(state.gate);
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
                    if (state.gate) this.assertConnectionOpen(state.gate);
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
        const current = currentTestSession();
        if (!current) return this.dispatchTransaction(propagation, callback, options);
        const retained = AsyncLocal.Frame?.txs.get(this);
        if (retained?.gate?.parent?.closed) throw new TransactionClosedError();
        if (testProvenance() === "withTestConnection") throw new Error("A transaction cannot start inside a withTestConnection callback");
        if (current.testConnectionActive) throw new Error("A transaction overlaps an active withTestConnection callback");
        const session = testSession(this);
        if (session) assertTestSessionReady(session);
        if (session && !session.admitting) throw new TransactionClosedError();
        // A mock's registration may already be restored to another manager, but
        // work retained by that closed session must not enter a real transaction.
        if (current !== session && (current.closed || "broken" in current)) {
            assertTestSessionReady(current);
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
