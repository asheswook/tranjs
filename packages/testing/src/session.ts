import "./bridge";
import { DEFAULT_DATASOURCE } from "@tranjs/core";
import { AsyncLocalStorage } from "node:async_hooks";
import { DatasourceSetupError, TransactionSystemError, clearTransactionManager, getTransactionManager, PlatformTransactionManager, useTransactionManager } from "@tranjs/core";
import { AsyncLocal, TxState, currentTestSession, hasTestTransaction, runTestSession, testAccess, TestBoundaryInfo, TestSession, testSession } from "@tranjs/core/internal/testing-bridge";
import { FakeTransactionManager } from "./fake";
import { registerProbeOwner, registerTrackedFunction, trackedFunctionForOwner, TrackedFunction } from "./metadata";

export interface TestTransactionInfo extends TestBoundaryInfo {
    readonly parent?: TestTransactionInfo;
}
export interface TestTransactionOptions {
    datasource?: string | symbol;
}
export interface TestFailureSelector {
    containing?: Function;
    where?: (info: TestTransactionInfo) => boolean;
    times?: number;
    error?: unknown;
}
export interface TestTransactionProbe {
    readonly datasource: string | symbol;
    readonly transactions: readonly TestTransactionInfo[];
    track<T extends object>(target: T): T;
    txOf(fn: Function, call?: number): TestTransactionInfo | undefined;
    fail(operation: "begin" | "commit" | "rollback", selector?: TestFailureSelector): void;
}

function createProbe(manager: PlatformTransactionManager<any>, datasource: string | symbol, kind: TestSession["kind"]): {
    probe: TestTransactionProbe; session: TestSession;
} {
    const transactions: TestTransactionInfo[] = [];
    const states = new WeakMap<TxState, TestTransactionInfo>();
    const outcomes = new WeakMap<TestTransactionInfo, TestTransactionInfo["outcome"]>();
    const calls = new WeakMap<Function, (TestTransactionInfo | undefined)[]>();
    const owner = {};
    let sequence = 0;
    const completions: TrackedFunction["completions"] = new WeakMap();
    let hookContext: AsyncLocalStorage<TestBoundaryInfo> | undefined;
    const wrappers = new WeakMap<object, object>();
    const failures: { operation: string; selector: TestFailureSelector; remaining: number }[] = [];
    const current = () => {
        const state = AsyncLocal.Frame?.txs.get(manager);
        return state?.active ? states.get(state) : undefined;
    };
    const trackedCalls = (fn: Function) => {
        const recorded = calls.get(fn);
        if (!recorded) throw new Error("Function was not tracked by this transaction probe");
        return recorded;
    };
    const wrapFunction = (target: Function, receiver?: object, propertyName?: string): Function => {
        for (const key of Reflect.ownKeys(target)) {
            const descriptor = Reflect.getOwnPropertyDescriptor(target, key)!;
            if (typeof descriptor.value === "function" && !descriptor.configurable && !descriptor.writable) {
                throw new TypeError("Cannot track a function with frozen function-valued properties; configure and track the mock before freezing it");
            }
        }
        const recorded = calls.get(target) ?? [];
        const entry: TrackedFunction = trackedFunctionForOwner(target, owner) ?? {
            owner, propertyName,
            get name() {
                const mockName = typeof (target as any).getMockName === "function" ? (target as any).getMockName() : undefined;
                return mockName && !["jest.fn()", "mockConstructor", "vi.fn()", "spy"].includes(mockName)
                    ? mockName : (entry.propertyName ?? (target.name === "spy" ? "" : target.name)) || "<anonymous>";
            },
            calls: [], completions,
        };
        if (propertyName !== undefined) entry.propertyName ??= propertyName;
        const methods = new Map<PropertyKey, { original: Function; wrapped: Function }>();
        const wrapper = new Proxy(target, {
            apply(fn, suppliedReceiver, args) {
                const transaction = current();
                recorded.push(transaction);
                entry.calls.push({ sequence: ++sequence, transaction, afterCommitOf: hookContext?.getStore() });
                return Reflect.apply(fn, receiver ?? suppliedReceiver, args);
            },
            get(fn, key) {
                const value = Reflect.get(fn, key, fn);
                // Leave Function.prototype.call/apply/bind untouched: they must
                // invoke this wrapper, retaining any explicitly supplied this.
                if (typeof value !== "function" || !Object.prototype.hasOwnProperty.call(fn, key)) return value;
                const cached = methods.get(key);
                if (cached && cached.original === value) return cached.wrapped;
                const wrapped = new Proxy(value, {
                    apply(method, _receiver, args) {
                        const result = Reflect.apply(method, fn, args);
                        return result === fn ? wrapper : result;
                    },
                });
                methods.set(key, { original: value, wrapped });
                return wrapped;
            },
        });
        calls.set(target, recorded);
        calls.set(wrapper, recorded);
        registerTrackedFunction(target, wrapper, entry);
        wrappers.set(wrapper, wrapper);
        return wrapper;
    };
    const track = <T extends object>(target: T, propertyName?: string): T => {
        if (!target || (typeof target !== "object" && typeof target !== "function")) {
            throw new TypeError("t.track expects a function or an object");
        }
        const existing = wrappers.get(target);
        if (existing) {
            if (typeof target === "function" && propertyName !== undefined) {
                trackedFunctionForOwner(target, owner)!.propertyName ??= propertyName;
            }
            return existing as T;
        }
        let wrapper: T;
        if (typeof target === "function") {
            wrapper = wrapFunction(target, undefined, propertyName) as T;
        } else {
            const methods = new WeakMap<Function, Function>();
            // A fresh extensible target avoids the get-trap invariants of
            // frozen originals. All reads/writes still address the original.
            wrapper = new Proxy(Object.create(Object.getPrototypeOf(target)), {
                get(_object, key) {
                    const value = Reflect.get(target, key, target);
                    if (typeof value !== "function") return value;
                    let method = methods.get(value);
                    if (!method) {
                        track(value, String(key));
                        method = wrapFunction(value, target, String(key));
                        methods.set(value, method);
                    }
                    return method;
                },
                set: (_object, key, value) => Reflect.set(target, key, value, target),
                has: (_object, key) => Reflect.has(target, key),
                ownKeys: () => Reflect.ownKeys(target),
                getOwnPropertyDescriptor(_object, key) {
                    const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
                    return descriptor ? { ...descriptor, configurable: true } : undefined;
                },
                defineProperty: (_object, key, descriptor) => Reflect.defineProperty(target, key, descriptor),
                deleteProperty: (_object, key) => Reflect.deleteProperty(target, key),
                preventExtensions() { throw new TypeError("Freeze the original object before tracking, not the tracked wrapper"); },
            });
        }
        wrappers.set(target, wrapper);
        wrappers.set(wrapper, wrapper);
        if (typeof target !== "function") {
            // Register function-valued properties without evaluating getters, so
            // selectors may refer to the original object's methods immediately.
            for (let object: object | null = target; object && object !== Object.prototype; object = Object.getPrototypeOf(object)) {
                for (const key of Reflect.ownKeys(object)) {
                    if (key === "constructor") continue;
                    const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
                    if (typeof descriptor.value === "function") track(descriptor.value, String(key));
                }
            }
        }
        return wrapper;
    };
    const probe: TestTransactionProbe = {
        datasource,
        get transactions() { return Object.freeze(transactions.slice()); },
        track,
        txOf(fn, call = 0) {
            const recorded = trackedCalls(fn);
            if (!Number.isInteger(call) || call < 0 || call >= recorded.length) {
                throw new RangeError(`Tracked function has ${recorded.length} recorded call(s); call ${call} does not exist`);
            }
            return recorded[call];
        },
        fail(operation, selector = {}) {
            if (!["begin", "commit", "rollback"].includes(operation)) throw new TypeError("Unknown transaction failure operation");
            if (selector.containing && selector.where) throw new TypeError("Choose containing or where, not both");
            if (selector.containing) {
                trackedCalls(selector.containing);
                if (operation === "begin") throw new Error("A begin failure cannot select containing: the tracked call has not run yet; use where or the next begin");
            }
            const times = selector.times ?? 1;
            if (!Number.isInteger(times) || times < 1) throw new RangeError("Failure times must be a positive integer");
            failures.push({ operation, selector: { ...selector }, remaining: times });
        },
    };
    const session: TestSession = {
        kind, lifecycle: kind === "mock" ? "ready" : "initializing",
        counter: 0, closed: false, root: { open: false },
        admitting: true, fixtureActive: false, managedActive: 0, pendingFixtures: new Set(),
        begin(options, propagation, parent) {
            const info: TestTransactionInfo = Object.freeze({
                id: transactions.length + 1,
                options: Object.freeze({ ...options }),
                parent: parent ? states.get(parent) : undefined,
                propagation,
                get outcome() { return outcomes.get(info)!; },
            });
            outcomes.set(info, "active");
            transactions.push(info);
            return info;
        },
        attach(state, info) { states.set(state, info); },
        complete(info, outcome) {
            outcomes.set(info, outcome);
            completions.set(info, { sequence: ++sequence, outcome });
        },
        runAfterCommit(state, callback) {
            const info = states.get(state);
            if (!info) return callback();
            hookContext ??= new AsyncLocalStorage<TestBoundaryInfo>();
            return hookContext.run(info, callback);
        },
        fail(operation, info) {
            const rule = failures.find(rule => rule.remaining > 0 && rule.operation === operation &&
                (!rule.selector.containing || trackedCalls(rule.selector.containing).includes(info)) &&
                (!rule.selector.where || rule.selector.where(info)));
            if (!rule) return;
            rule.remaining--;
            throw "error" in rule.selector ? rule.selector.error : new Error(`Test transaction ${operation} failed`);
        },
    };
    probes.set(session, probe);
    registerProbeOwner(session, owner);
    return { probe, session };
}

const probes = new WeakMap<TestSession, TestTransactionProbe>();

/** The current test's probe. A retained async task cannot access a closed test. */
export function transactions(datasource?: string | symbol): TestTransactionProbe {
    const manager = datasource === undefined ? undefined : registeredManager(datasource);
    const session = datasource === undefined ? currentTestSession() : manager && testSession(manager);
    if (!session || session.closed) throw new Error("transactions() requires an active transaction test session");
    const probe = probes.get(session);
    if (!probe) throw new Error("transactions() requires an active transaction test session");
    return probe;
}

function registeredManager(datasource: string | symbol): PlatformTransactionManager<any> | undefined {
    try { return getTransactionManager(datasource); }
    catch (error) {
        if (!(error instanceof DatasourceSetupError)) throw error;
        return undefined;
    }
}
const mocking = new Set<string | symbol>();

/** Unit-test transaction policy. Mock data access: real driver ctx() rejects this manager. */
export async function mockTransactions<T>(fn: (t: TestTransactionProbe) => T | Promise<T>, options: TestTransactionOptions = {}): Promise<T> {
    const datasource = options.datasource ?? DEFAULT_DATASOURCE;
    if (mocking.has(datasource)) throw new Error(`Concurrent or nested mockTransactions for datasource ${String(datasource)} is not supported`);
    mocking.add(datasource);
    const previous = registeredManager(datasource);
    const manager = new FakeTransactionManager();
    const { probe, session } = createProbe(manager, datasource, "mock");
    useTransactionManager(manager, datasource);
    try { return await runTestSession(manager, session, () => fn(probe)); }
    finally {
        session.admitting = false;
        session.closed = true;
        if (previous) useTransactionManager(previous, datasource);
        else clearTransactionManager(datasource);
        mocking.delete(datasource);
    }
}

/** Savepoint-based integration test; always roll back the hidden physical transaction. */
export async function withTestTransaction<T>(fn: (t: TestTransactionProbe) => T | Promise<T>, options: TestTransactionOptions = {}): Promise<T> {
    const datasource = options.datasource ?? DEFAULT_DATASOURCE;
    const manager = getTransactionManager(datasource);
    const existing = testSession(manager);
    if (hasTestTransaction() || (existing && !existing.closed)) throw new Error("Nested withTestTransaction calls are not supported");
    const access = testAccess.get(manager)!;
    const { probe, session } = createProbe(manager, datasource, "integration");
    return runTestSession(manager, session, async () => {
        try {
            session.context = await access.outside(() => access.begin());
            session.lifecycle = "ready";
        } catch (error) {
            session.lifecycle = "failed";
            session.initializationError = error;
            session.closed = true;
            throw error;
        }
        let failure: { error: unknown } | undefined;
        try {
            return await access.outside(() => fn(probe));
        } catch (error) {
            failure = { error };
            throw error;
        } finally {
            session.admitting = false;
            if (session.pendingFixtures.size) {
                const settled = await Promise.allSettled([...session.pendingFixtures]);
                const errors = [new Error("withTestTransaction callback exited with pending fixture work"),
                    ...(failure ? [failure.error] : []),
                    ...settled.flatMap(result => result.status === "rejected" ? [result.reason] : [])];
                failure = { error: new AggregateError(errors, "Pending fixture work drained before test rollback") };
            }
            session.closed = true;
            // A caught owner failure cannot make an unrecoverable session pass.
            // Keep the full application/recovery pair, including thrown undefined.
            if ("broken" in session && (!failure || failure.error !== session.broken)) {
                failure = { error: failure ? new TransactionSystemError(session.broken, failure.error) : session.broken };
            }
            let cleanupFailed = false;
            try { await access.outside(() => access.rollback(session.context!.transaction)); }
            catch (error) {
                cleanupFailed = true;
                if (failure) access.logError("Transaction application error before rollback failure", failure.error);
                else access.logError("Transaction rollback failed", error);
                failure = { error: failure ? new TransactionSystemError(error, failure.error) : error };
            }
            try { await access.outside(() => access.release(session.context!.transaction, cleanupFailed || "broken" in session)); }
            catch (error) {
                cleanupFailed = true;
                access.logError("Transaction release failed", error);
                failure = { error: failure ? new TransactionSystemError(error, failure.error) : error };
            }
            if (failure) throw failure.error;
        }
    });
}
