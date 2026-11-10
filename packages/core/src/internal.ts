import { AsyncLocalStorage } from "node:async_hooks";
import type { MetadataWrappedTransaction } from "./context";
import type { TransactionOptions } from "./config";
import type { PlatformTransactionManager } from "./manager";
import type { Propagation } from "./propagation";
import type { TxState } from "./asyncLocal";

// Private bridge: testing never replaces or monkeypatches a real driver manager.
export interface TestBoundaryInfo {
    readonly id: number;
    readonly options: Readonly<TransactionOptions>;
    readonly parent?: TestBoundaryInfo;
    readonly propagation: Propagation;
    readonly outcome: "active" | "committed" | "rolled-back";
}
export interface TestSession {
    readonly kind: "mock" | "integration";
    lifecycle: "initializing" | "ready" | "failed";
    initializationError?: unknown;
    context?: MetadataWrappedTransaction<any>;
    counter: number;
    closed: boolean;
    broken?: unknown;
    root: { open: boolean };
    admitting: boolean;
    fixtureActive: boolean;
    managedActive: number;
    pendingFixtures: Set<Promise<unknown>>;
    begin(options: TransactionOptions, propagation: Propagation, parent?: TxState): TestBoundaryInfo;
    attach(state: TxState, info: TestBoundaryInfo): void;
    complete(info: TestBoundaryInfo, outcome: "committed" | "rolled-back"): void;
    fail(operation: "begin" | "commit" | "rollback", info: TestBoundaryInfo): void;
    runAfterCommit<T>(state: TxState, callback: () => T): T;
}
export const testAccess = new WeakMap<PlatformTransactionManager<any>, {
    begin(options?: TransactionOptions): Promise<MetadataWrappedTransaction<any>>;
    rollback(tx: any): Promise<void>;
    release(tx: any, failed: boolean): Promise<void>;
    outside<T>(fn: () => T): T;
    logError(message: string, error: unknown): void;
    fixtureConnection(tx: any, lease: FixtureLease): unknown;
    createSavepoint(tx: any, name: string): Promise<void>;
    rollbackToSavepoint(tx: any, name: string): Promise<void>;
    releaseSavepoint(tx: any, name: string): Promise<void>;
}>();
/** Internal driver capability protocol; never supplies ambient transaction access. */
export interface FixtureLease {
    assert(): void;
    track<T>(operation: () => PromiseLike<T>): Promise<T>;
}
interface TestStore {
    sessions: Map<PlatformTransactionManager<any>, TestSession>;
    scopes: Map<PlatformTransactionManager<any>, { open: boolean }>;
    provenance?: "fixture" | "managed" | "hook";
}
// Importing the production entry initializes the bridge, not a testing context.
// Allocate the extra async-local storage only when a testing helper is used.
let storage: AsyncLocalStorage<TestStore> | undefined;
export function assertTestSessionReady(session: TestSession): void {
    if (session.lifecycle === "failed") {
        const error = new Error("Test transaction initialization failed");
        Object.assign(error, { cause: session.initializationError });
        throw error;
    }
    if (session.closed || "broken" in session) throw new Error("Test transaction is closed or broken");
    if (session.kind === "integration" && (session.lifecycle !== "ready" || !session.context)) {
        throw new Error("Test transaction has not begun: initialization is still in progress");
    }
}
export function testSession(manager: PlatformTransactionManager<any>): TestSession | undefined {
    return storage?.getStore()?.sessions.get(manager);
}
export function currentTestSession(): TestSession | undefined {
    const sessions = storage?.getStore()?.sessions;
    return sessions ? Array.from(sessions.values()).reverse()[0] : undefined;
}
export function testProvenance(): TestStore["provenance"] {
    return storage?.getStore()?.provenance;
}
export function runTestProvenance<T>(provenance: NonNullable<TestStore["provenance"]>, fn: () => T): T {
    const store = storage?.getStore();
    return store ? storage!.run({ ...store, provenance: store.provenance === "fixture" ? "fixture" : provenance }, fn) : fn();
}
export function hasTestTransaction(): boolean {
    return Array.from(storage?.getStore()?.sessions.values() ?? []).some(session => !session.closed && session.kind === "integration");
}
export function runTestSession<T>(manager: PlatformTransactionManager<any>, session: TestSession, fn: () => T): T {
    storage ??= new AsyncLocalStorage<TestStore>();
    const sessions = new Map(storage.getStore()?.sessions);
    sessions.delete(manager);
    sessions.set(manager, session);
    return storage.run({ ...storage.getStore(), sessions, scopes: new Map(storage.getStore()?.scopes) }, fn);
}
export function testScope<T>(manager: PlatformTransactionManager<any>, fn: () => Promise<T>): Promise<T> {
    const store = storage?.getStore();
    const session = store?.sessions.get(manager);
    try { if (session) assertTestSessionReady(session); }
    catch (error) { return Promise.reject(error); }
    if (!session?.context) return fn();
    const parent = store!.scopes.get(manager) ?? session.root;
    if (parent.open) return Promise.reject(new Error("Overlapping transaction savepoint scopes inside withTestTransaction are not supported; await each branch"));
    parent.open = true;
    const scopes = new Map(store!.scopes);
    scopes.set(manager, { open: false });
    return storage!.run({ ...store!, scopes }, fn).finally(() => { parent.open = false; });
}
