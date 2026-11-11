import { getTransactionManager } from "../manager";
import { TransactionSystemError } from "../error";
import { assertTestSessionReady, currentTestSession, TestConnectionLease, runTestProvenance, testAccess, testProvenance, testScope, testSession } from "../internal";

/** Internal executor: admission and the shared overlap gate precede the first await. */
export function executeTestConnection<C, R>(fn: (db: C) => R, datasource?: string | symbol): Promise<Awaited<R>> {
    try {
        const current = currentTestSession();
        if (!current) throw new Error("withTestConnection requires an active withTestTransaction callback");
        assertTestSessionReady(current);
        const manager = getTransactionManager(datasource ?? current.datasource);
        const session = testSession(manager);
        if (!session) throw new Error("withTestConnection requires an active withTestTransaction callback");
        if (session.kind === "mock") throw new Error("withTestConnection is unavailable in mockTransactions");
        assertTestSessionReady(session);
        if (!session.admitting) throw new Error("withTestConnection was called after the withTestTransaction callback finished");
        if (testProvenance()) throw new Error("withTestConnection was called inside another connection callback, a transaction callback or a transaction hook");
        if (session.root.open || session.managedActive || session.testConnectionActive) throw new Error("withTestConnection overlaps another connection callback or transaction");
        const access = testAccess.get(manager)!;
        const tx = session.context!.transaction;
        const name = `tranjs_${session.id}_connection_${++session.counter}`;
        let open = true;
        const pending = new Set<Promise<unknown>>();
        const errors: unknown[] = [];
        const lease: TestConnectionLease = {
            assert() { if (!open) throw new Error("The connection was used after its withTestConnection callback finished"); },
            track<T>(operation: () => PromiseLike<T>): Promise<T> {
                lease.assert();
                const promise = Promise.resolve(operation());
                pending.add(promise);
                promise.then(() => pending.delete(promise), error => { pending.delete(promise); errors.push(error); });
                return promise;
            },
        };
        session.testConnectionActive = true;
        let resolve!: (value: Awaited<R>) => void;
        let reject!: (error: unknown) => void;
        const operation = new Promise<Awaited<R>>((yes, no) => { resolve = yes; reject = no; });
        session.pendingConnections.add(operation);
        // Install rejection handling immediately, including intentionally forgotten calls.
        operation.then(() => session.pendingConnections.delete(operation), () => session.pendingConnections.delete(operation));
        const work = testScope(manager, async () => {
            let savepoint = false;
            let value: Awaited<R> | undefined;
            let failure: { error: unknown } | undefined;
            try {
                await access.createSavepoint(tx, name);
                savepoint = true;
                value = await runTestProvenance("withTestConnection", async () => {
                    const db = access.testConnection(tx, lease) as C;
                    const returned = fn(db);
                    if ((returned as unknown) === db) throw new Error("withTestConnection returned its connection");
                    const result = await returned;
                    if (result === db) throw new Error("withTestConnection returned its connection");
                    return result;
                });
            } catch (error) { failure = { error }; }
            open = false;
            const floating = pending.size > 0;
            await Promise.allSettled([...pending]);
            const failures = [...new Set([...(failure ? [failure.error] : []), ...errors])];
            if (floating) failures.push(new Error("withTestConnection callback completed with pending query work"));
            if (failures.length) failure = { error: failures.length === 1 ? failures[0] : new AggregateError(failures, "withTestConnection callback and query work failed") };
            if (!savepoint) {
                session.broken = failure!.error;
                throw failure!.error;
            }
            if (!failure) {
                try { await access.releaseSavepoint(tx, name); return value as Awaited<R>; }
                catch (error) { failure = { error }; }
            }
            try {
                await access.rollbackToSavepoint(tx, name);
                await access.releaseSavepoint(tx, name);
            } catch (error) {
                session.broken = new TransactionSystemError(error, failure.error);
                throw session.broken;
            }
            throw failure.error;
        });
        work.then(value => { session.testConnectionActive = false; resolve(value as Awaited<R>); }, error => { session.testConnectionActive = false; reject(error); });
        return operation;
    } catch (error) { return Promise.reject(error); }
}
