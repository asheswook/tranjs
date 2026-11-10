import { getTransactionManager } from "../manager";
import { TransactionSystemError } from "../error";
import { assertTestSessionReady, currentTestSession, FixtureLease, runTestProvenance, testAccess, testProvenance, testScope, testSession } from "../internal";

/** Internal executor: admission and the shared overlap gate precede the first await. */
export function executeFixture<C, R>(fn: (connection: C) => R, datasource?: string | symbol): Promise<Awaited<R>> {
    try {
        const current = currentTestSession();
        if (!current) throw new Error("fixture requires a live withTestTransaction session");
        assertTestSessionReady(current);
        const manager = getTransactionManager(datasource);
        const session = testSession(manager);
        if (!session) throw new Error("fixture requires a live withTestTransaction session");
        if (session.kind === "mock") throw new Error("fixture is unavailable in mockTransactions");
        assertTestSessionReady(session);
        if (!session.admitting) throw new Error("Test session no longer admits fixture work");
        if (testProvenance()) throw new Error("fixture is forbidden inside a fixture, managed callback or hook");
        if (session.root.open || session.managedActive || session.fixtureActive) throw new Error("fixture overlaps an active fixture or managed transaction");
        const access = testAccess.get(manager)!;
        const tx = session.context!.transaction;
        const name = `tranjs_fixture_${++session.counter}`;
        let open = true;
        const pending = new Set<Promise<unknown>>();
        const errors: unknown[] = [];
        const lease: FixtureLease = {
            assert() { if (!open) throw new Error("Fixture connection lease is revoked after callback completion"); },
            track<T>(operation: () => PromiseLike<T>): Promise<T> {
                lease.assert();
                const promise = Promise.resolve(operation());
                pending.add(promise);
                promise.then(() => pending.delete(promise), error => { pending.delete(promise); errors.push(error); });
                return promise;
            },
        };
        session.fixtureActive = true;
        let resolve!: (value: Awaited<R>) => void;
        let reject!: (error: unknown) => void;
        const operation = new Promise<Awaited<R>>((yes, no) => { resolve = yes; reject = no; });
        session.pendingFixtures.add(operation);
        // Install rejection handling immediately, including intentionally forgotten calls.
        operation.then(() => session.pendingFixtures.delete(operation), () => session.pendingFixtures.delete(operation));
        const work = testScope(manager, async () => {
            let savepoint = false;
            let value: Awaited<R> | undefined;
            let failure: { error: unknown } | undefined;
            try {
                await access.createSavepoint(tx, name);
                savepoint = true;
                value = await runTestProvenance("fixture", async () => {
                    const connection = access.fixtureConnection(tx, lease) as C;
                    const returned = fn(connection);
                    if ((returned as unknown) === connection) throw new Error("fixture returned its connection facade");
                    const result = await returned;
                    if (result === connection) throw new Error("fixture returned its connection facade");
                    return result;
                });
            } catch (error) { failure = { error }; }
            open = false;
            const floating = pending.size > 0;
            await Promise.allSettled([...pending]);
            const failures = [...new Set([...(failure ? [failure.error] : []), ...errors])];
            if (floating) failures.push(new Error("fixture callback completed with pending query work"));
            if (failures.length) failure = { error: failures.length === 1 ? failures[0] : new AggregateError(failures, "Fixture callback and query work failed") };
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
        work.then(value => { session.fixtureActive = false; resolve(value as Awaited<R>); }, error => { session.fixtureActive = false; reject(error); });
        return operation;
    } catch (error) { return Promise.reject(error); }
}
