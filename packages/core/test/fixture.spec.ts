import {
    afterCommit, afterRollback, clearTransactionManager, ctx, DatasourceSetupError,
    Propagation, transactional, TransactionSystemError, useTransactionManager,
} from "../src";
import { fixture, mockTransactions, transactions, withTestTransaction } from "../../testing/src";
import { FakeTransactionManager } from "../../testing/src/fake";
import { FixtureLease, testSession } from "../src/internal";

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

interface Connection {
    query<T>(operation: PromiseLike<T>): Promise<T>;
}

/** An opt-in driver capability; the ordinary fake deliberately remains unsupported. */
class FixtureManager extends FakeTransactionManager {
    readonly query = jest.fn((operation: PromiseLike<unknown>) => operation);
    readonly createSavepoint = jest.fn(async (_tx?: object, _name?: string) => {});
    readonly rollbackToSavepoint = jest.fn(async (_tx?: object, _name?: string) => {});
    readonly releaseSavepoint = jest.fn(async (_tx?: object, _name?: string) => {});
    readonly rollbackTransaction = jest.fn(async () => {});
    readonly releaseTransaction = jest.fn(async (_tx: object, _failed: boolean) => {});
    readonly checkTestTransactionConstraints = jest.fn(async (_tx: object, _name: string) => {});
    readonly createFixtureConnection = jest.fn((_tx: object, lease: FixtureLease): Connection => ({
        query: <T>(operation: PromiseLike<T>) => lease.track(() => this.query(operation) as PromiseLike<T>),
    }));
    remainingTimeout() { return this.getRemainingTimeout(); }
}

describe("fixture", () => {
    const other = Symbol("other fixture datasource");
    let manager: FixtureManager;

    beforeEach(() => {
        manager = new FixtureManager();
        manager.setLogger({ error: jest.fn() } as any);
        useTransactionManager(manager);
    });

    afterEach(() => {
        clearTransactionManager();
        clearTransactionManager(other);
        jest.restoreAllMocks();
    });

    it("uses a hidden-transaction savepoint without a logical owner, deadline, probe record or constraint check", async () => {
        await withTestTransaction(async t => {
            const mark = t.track(jest.fn());
            t.fail("begin");
            t.fail("commit");
            t.fail("rollback");
            const hooks = jest.fn();
            expect(await fixture(async (connection: Connection) => {
                mark();
                expect(manager.getCurrentTransaction()).toBeUndefined();
                expect(manager.remainingTimeout()).toBeUndefined();
                expect(() => ctx()).toThrow("No transaction context");
                expect(transactions()).toBe(t);
                afterRollback(hooks);
                const result = await connection.query(Promise.resolve({ id: 7 }));
                return result;
            })).toEqual({ id: 7 });
            expect(t.txOf(mark)).toBeUndefined();
            expect(t.transactions).toEqual([]);
            expect(hooks).not.toHaveBeenCalled();
            expect(manager.checkTestTransactionConstraints).not.toHaveBeenCalled();
            const tx = testSession(manager)!.context!.transaction;
            expect(manager.createFixtureConnection).toHaveBeenCalledWith(tx, expect.any(Object));
            expect(manager.createSavepoint).toHaveBeenCalledWith(tx, "tranjs_fixture_1");
            expect(manager.releaseSavepoint).toHaveBeenCalledWith(tx, "tranjs_fixture_1");
            expect(manager.rollbackToSavepoint).not.toHaveBeenCalled();
            expect(await fixture(() => 42)).toBe(42);
            expect(manager.createSavepoint).toHaveBeenLastCalledWith(tx, "tranjs_fixture_2");
        });
        expect(manager.rollbackTransaction).toHaveBeenCalledTimes(1);
        expect(manager.releaseTransaction).toHaveBeenCalledWith(expect.any(Object), false);
    });

    it("selects a named datasource", async () => {
        const named = new FixtureManager();
        useTransactionManager(named, other);
        await withTestTransaction(async () => {
            expect(await fixture((c: Connection) => c.query(Promise.resolve("named")), { datasource: other })).toBe("named");
        }, { datasource: other });
        expect(named.createFixtureConnection).toHaveBeenCalledTimes(1);
        expect(manager.createSavepoint).not.toHaveBeenCalled();
    });

    it("rejects outside a session and for an unregistered datasource as promises", async () => {
        const callback = jest.fn();
        await expect(fixture(callback)).rejects.toThrow("live withTestTransaction");
        await withTestTransaction(async () => {
            await expect(fixture(callback, { datasource: other })).rejects.toBeInstanceOf(DatasourceSetupError);
            useTransactionManager(new FixtureManager(), other);
            await expect(fixture(callback, { datasource: other })).rejects.toThrow("live withTestTransaction");
        });
        expect(callback).not.toHaveBeenCalled();
        expect(manager.createSavepoint).not.toHaveBeenCalled();
    });

    it("rejects mock sessions before invoking the callback", async () => {
        const callback = jest.fn();
        await mockTransactions(async () => {
            await expect(fixture(callback)).rejects.toThrow("unavailable in mockTransactions");
        });
        expect(callback).not.toHaveBeenCalled();
    });

    it("keeps the default fake unsupported and recovers its fixture savepoint", async () => {
        const fake = new FakeTransactionManager();
        useTransactionManager(fake);
        const rollback = jest.spyOn(fake as any, "rollbackToSavepoint");
        const release = jest.spyOn(fake as any, "releaseSavepoint");
        const callback = jest.fn();
        await withTestTransaction(async () => {
            await expect(fixture(callback)).rejects.toThrow("does not support fixture connections");
            await expect(transactional(() => 7)()).resolves.toBe(7);
        });
        expect(callback).not.toHaveBeenCalled();
        expect(rollback).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledWith(expect.any(Object), "tranjs_fixture_1");
    });

    it("rejects retained work after the session closes", async () => {
        const gate = deferred();
        const callback = jest.fn();
        let retained!: Promise<void>;
        await withTestTransaction(() => {
            retained = gate.promise.then(async () => {
                await expect(fixture(callback)).rejects.toThrow("closed or broken");
            });
        });
        gate.resolve();
        await retained;
        expect(callback).not.toHaveBeenCalled();
        expect(manager.createSavepoint).not.toHaveBeenCalled();
    });

    it("checks initialization, context and admission before touching the driver", async () => {
        const callback = jest.fn();
        await withTestTransaction(async () => {
            const session = testSession(manager)!;
            session.lifecycle = "initializing";
            await expect(fixture(callback)).rejects.toThrow("initialization is still in progress");
            session.lifecycle = "ready";
            const context = session.context;
            session.context = undefined;
            await expect(fixture(callback)).rejects.toThrow("initialization is still in progress");
            session.context = context;
            const error = new Error("begin failed");
            session.lifecycle = "failed";
            session.initializationError = error;
            await expect(fixture(callback)).rejects.toMatchObject({ message: "Test transaction initialization failed", cause: error });
            session.lifecycle = "ready";
            session.admitting = false;
            await expect(fixture(callback)).rejects.toThrow("no longer admits fixture work");
            session.admitting = true;
        });
        expect(callback).not.toHaveBeenCalled();
        expect(manager.createSavepoint).not.toHaveBeenCalled();
    });

    it("reserves fixture admission synchronously before awaiting savepoint creation", async () => {
        const savepoint = deferred();
        manager.createSavepoint.mockImplementationOnce(() => savepoint.promise);
        const callback = jest.fn(() => "first");
        const denied = jest.fn();
        await withTestTransaction(async () => {
            const first = fixture(callback);
            expect(testSession(manager)!.fixtureActive).toBe(true);
            expect(callback).not.toHaveBeenCalled();
            await expect(fixture(denied)).rejects.toThrow("overlaps an active");
            await expect(transactional(denied)()).rejects.toThrow("overlaps an active fixture");
            savepoint.resolve();
            expect(await first).toBe("first");
            expect(testSession(manager)!.fixtureActive).toBe(false);
            expect(await fixture(() => "next")).toBe("next");
        });
        expect(denied).not.toHaveBeenCalled();
    });

    it.each([Propagation.REQUIRED, Propagation.SUPPORTS, Propagation.NOT_SUPPORTED])(
        "reserves managed admission synchronously for %s", async propagation => {
            const entered = deferred();
            const gate = deferred();
            const callback = jest.fn();
            await withTestTransaction(async () => {
                const work = transactional(async () => { entered.resolve(); await gate.promise; }, { propagation })();
                // SUPPORTS/NOT_SUPPORTED have no owner savepoint, but still own the overlap gate.
                await expect(fixture(callback)).rejects.toThrow("overlaps an active");
                await entered.promise;
                gate.resolve();
                await work;
                await fixture(() => "recovered");
            });
            expect(callback).not.toHaveBeenCalled();
        },
    );

    it("checks every shared admission gate independently", async () => {
        await withTestTransaction(async () => {
            const session = testSession(manager)!;
            session.managedActive = 1;
            await expect(fixture(() => {})).rejects.toThrow("overlaps an active");
            session.managedActive = 0;
            session.fixtureActive = true;
            await expect(fixture(() => {})).rejects.toThrow("overlaps an active");
            session.fixtureActive = false;
            session.root.open = true;
            await expect(fixture(() => {})).rejects.toThrow("overlaps an active");
            session.root.open = false;
        });
        expect(manager.createSavepoint).not.toHaveBeenCalled();
    });

    it.each(Object.values(Propagation))("centrally denies %s inside a fixture, including another datasource", async propagation => {
        const secondary = new FixtureManager();
        useTransactionManager(secondary, other);
        const denied = jest.fn();
        await withTestTransaction(async () => {
            await fixture(async () => {
                await Promise.resolve();
                for (const datasource of [undefined, other]) {
                    await expect(transactional(denied, { propagation, datasource })()).rejects.toThrow("forbidden inside a fixture callback");
                }
                await expect(secondary.executeTransaction(propagation, denied)).rejects.toThrow("forbidden inside a fixture callback");
                await expect(fixture(denied)).rejects.toThrow("fixture is forbidden");
            });
        });
        expect(denied).not.toHaveBeenCalled();
        expect(secondary.createSavepoint).not.toHaveBeenCalled();
    });

    it("retains fixture provenance in delayed continuations after the overlap gate closes", async () => {
        const gate = deferred();
        const denied = jest.fn();
        let retained!: Promise<void>;
        await withTestTransaction(async () => {
            await fixture(() => {
                retained = gate.promise.then(async () => {
                    await expect(transactional(denied, { propagation: Propagation.SUPPORTS })()).rejects.toThrow("forbidden inside a fixture callback");
                    await expect(fixture(denied)).rejects.toThrow("fixture is forbidden");
                });
            });
            expect(testSession(manager)!.fixtureActive).toBe(false);
            gate.resolve();
            await retained;
        });
        expect(denied).not.toHaveBeenCalled();
    });

    it("forbids fixture entry from managed callbacks, rollback/commit hooks and retained hook continuations", async () => {
        const denied = jest.fn();
        const resume = deferred();
        let rollbackCalls = 0;
        let rollbackResult: PromiseSettledResult<unknown> | undefined;
        let retained!: Promise<PromiseSettledResult<unknown>[]>;
        const rollbackHook = async () => {
            rollbackCalls++;
            [rollbackResult] = await Promise.allSettled([fixture(denied)]);
            retained = resume.promise.then(() => Promise.allSettled([fixture(denied)]));
        };
        await withTestTransaction(async () => {
            await transactional(async () => {
                await expect(fixture(denied)).rejects.toThrow("fixture is forbidden");
                afterCommit(async () => {
                    await expect(fixture(denied)).rejects.toThrow("fixture is forbidden");
                });
            })();
            const error = new Error("owner rollback");
            await expect(transactional(() => {
                afterRollback(rollbackHook);
                throw error;
            })()).rejects.toBe(error);
            expect(rollbackCalls).toBe(1);
            expect(rollbackResult).toMatchObject({
                status: "rejected", reason: { message: "fixture is forbidden inside a fixture, managed callback or hook" },
            });
            expect(testSession(manager)!.root.open).toBe(false);
            expect(testSession(manager)!.managedActive).toBe(0);
            await fixture(() => 1);
            resume.resolve();
            const [retainedResult] = await retained;
            expect(retainedResult).toMatchObject({
                status: "rejected", reason: { message: "fixture is forbidden inside a fixture, managed callback or hook" },
            });
            await afterCommit(async () => {
                await Promise.resolve();
                await expect(fixture(denied)).rejects.toThrow("fixture is forbidden");
            });
            await fixture(async () => {
                await afterCommit(async () => {
                    await expect(fixture(denied)).rejects.toThrow("fixture is forbidden");
                });
            });
            await fixture(() => 1);
        });
        expect(denied).not.toHaveBeenCalled();
        expect(rollbackCalls).toBe(1);
    });

    it.each([new Error("callback"), undefined, null, "callback failure"])("rolls back callback failure %p without poisoning the session", async error => {
        await withTestTransaction(async () => {
            await expect(fixture(() => { throw error; })).rejects.toBe(error);
            expect(manager.rollbackToSavepoint).toHaveBeenCalledWith(expect.any(Object), "tranjs_fixture_1");
            expect(manager.releaseSavepoint).toHaveBeenCalledTimes(1);
            await expect(fixture(() => "recovered")).resolves.toBe("recovered");
        });
        expect(manager.releaseTransaction).toHaveBeenCalledWith(expect.any(Object), false);
    });

    it("reports a caught query failure and deduplicates a query rejection also thrown by the callback", async () => {
        const error = new Error("query");
        await withTestTransaction(async () => {
            await expect(fixture(async (c: Connection) => {
                await expect(c.query(Promise.reject(error))).rejects.toBe(error);
                return "caught";
            })).rejects.toBe(error);
            await expect(fixture((c: Connection) => c.query(Promise.reject(error)))).rejects.toBe(error);
            await fixture(() => "recovered");
        });
        expect(manager.rollbackToSavepoint).toHaveBeenCalledTimes(2);
    });

    it("aggregates distinct callback and settled query failures", async () => {
        const queryError = new Error("query");
        const callbackError = new Error("callback");
        await withTestTransaction(async () => {
            await expect(fixture(async (c: Connection) => {
                await c.query(Promise.reject(queryError)).catch(() => {});
                throw callbackError;
            })).rejects.toMatchObject({
                message: "Fixture callback and query work failed",
                errors: [callbackError, queryError],
            });
        });
    });

    it("recovers a synchronous query-adapter exception", async () => {
        const error = new Error("synchronous query failure");
        manager.query.mockImplementationOnce(() => { throw error; });
        await withTestTransaction(async () => {
            await expect(fixture((c: Connection) => c.query(Promise.resolve(1)))).rejects.toBe(error);
            await expect(fixture((c: Connection) => c.query(Promise.resolve(2)))).resolves.toBe(2);
        });
        expect(manager.rollbackToSavepoint).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])("revokes and drains unawaited query work before recovery (query fails: %s)", async fails => {
        const query = deferred<number>();
        const returned = deferred();
        const queryError = new Error("late query");
        let connection!: Connection;
        await withTestTransaction(async () => {
            const work = fixture((c: Connection) => {
                connection = c;
                void c.query(query.promise);
                returned.resolve();
                return "callback done";
            });
            await returned.promise;
            // Let the executor observe callback completion, not just callback entry.
            await Promise.resolve();
            await Promise.resolve();
            expect(() => connection.query(Promise.resolve(0))).toThrow("lease is revoked");
            expect(manager.rollbackToSavepoint).not.toHaveBeenCalled();
            expect(manager.releaseSavepoint).not.toHaveBeenCalled();
            const assertion = fails
                ? expect(work).rejects.toMatchObject({ errors: [queryError, expect.objectContaining({ message: expect.stringContaining("pending query work") })] })
                : expect(work).rejects.toThrow("pending query work");
            if (fails) query.reject(queryError);
            else query.resolve(7);
            await assertion;
            expect(manager.rollbackToSavepoint).toHaveBeenCalledTimes(1);
            await fixture(() => "recovered");
        });
        expect(manager.query).toHaveBeenCalledTimes(1);
    });

    it("drains multiple floating queries and retains a callback failure including undefined", async () => {
        const first = deferred();
        const second = deferred();
        const returned = deferred();
        const queryError = new Error("query");
        await withTestTransaction(async () => {
            const work = fixture((c: Connection) => {
                void c.query(first.promise);
                void c.query(second.promise);
                returned.resolve();
                throw undefined;
            });
            await returned.promise;
            await Promise.resolve();
            const assertion = expect(work).rejects.toMatchObject({ errors: [undefined, queryError, expect.any(Error)] });
            first.reject(queryError);
            await Promise.resolve();
            expect(manager.rollbackToSavepoint).not.toHaveBeenCalled();
            second.resolve();
            await assertion;
        });
    });

    it.each([false, true])("rejects returning the facade directly (async: %s) and revokes it", async asynchronous => {
        let retained!: Connection;
        await withTestTransaction(async () => {
            await expect(fixture((connection: Connection) => {
                retained = connection;
                return asynchronous ? Promise.resolve(connection) : connection;
            })).rejects.toThrow("returned its connection facade");
            expect(() => retained.query(Promise.resolve(1))).toThrow("lease is revoked");
            await fixture(() => "recovered");
        });
        expect(manager.query).not.toHaveBeenCalled();
        expect(manager.rollbackToSavepoint).toHaveBeenCalledTimes(1);
    });

    it("does not deep-scan returned data, invoke getters or permit a nested facade to outlive the lease", async () => {
        const getter = jest.fn(() => { throw new Error("must not inspect data"); });
        await withTestTransaction(async () => {
            const result = await fixture((connection: Connection) => {
                const data = { nested: [connection], value: 7 };
                Object.defineProperty(data, "untouched", { get: getter });
                return data;
            });
            expect(result.value).toBe(7);
            expect(getter).not.toHaveBeenCalled();
            expect(() => result.nested[0].query(Promise.resolve(1))).toThrow("lease is revoked");
        });
        expect(manager.rollbackToSavepoint).not.toHaveBeenCalled();
        expect(manager.query).not.toHaveBeenCalled();
    });

    it.each([new Error("create savepoint"), undefined])("poisons the session if savepoint creation throws %p", async error => {
        manager.createSavepoint.mockRejectedValueOnce(error);
        const callback = jest.fn();
        await expect(withTestTransaction(async () => {
            await expect(fixture(callback)).rejects.toBe(error);
            await expect(fixture(callback)).rejects.toThrow("closed or broken");
            await expect(transactional(callback)()).rejects.toThrow("closed or broken");
        })).rejects.toBe(error);
        expect(callback).not.toHaveBeenCalled();
        expect(manager.rollbackToSavepoint).not.toHaveBeenCalled();
        expect(manager.releaseSavepoint).not.toHaveBeenCalled();
        expect(manager.releaseTransaction).toHaveBeenCalledWith(expect.any(Object), true);
    });

    it("recovers a first release failure without poisoning the session", async () => {
        const error = new Error("release");
        manager.releaseSavepoint.mockRejectedValueOnce(error);
        await withTestTransaction(async () => {
            await expect(fixture(() => 7)).rejects.toBe(error);
            expect(manager.rollbackToSavepoint).toHaveBeenCalledTimes(1);
            expect(manager.releaseSavepoint).toHaveBeenCalledTimes(2);
            await expect(fixture(() => "recovered")).resolves.toBe("recovered");
        });
        expect(manager.releaseTransaction).toHaveBeenCalledWith(expect.any(Object), false);
    });

    it.each(["rollback", "release"])("poisons on fixture recovery %s failure and preserves the application error", async operation => {
        const applicationError = new Error("callback");
        const recoveryError = new Error(operation);
        if (operation === "rollback") manager.rollbackToSavepoint.mockRejectedValueOnce(recoveryError);
        else manager.releaseSavepoint.mockRejectedValueOnce(recoveryError);
        let broken!: unknown;
        const work = withTestTransaction(async () => {
            try { await fixture(() => { throw applicationError; }); }
            catch (error) { broken = error; }
            expect(broken).toBeInstanceOf(TransactionSystemError);
            expect(broken).toMatchObject({ cause: recoveryError, applicationError });
            await expect(fixture(() => 1)).rejects.toThrow("closed or broken");
        });
        const result = await work.catch(error => error);
        expect(result).toBe(broken);
        expect(manager.releaseTransaction).toHaveBeenCalledWith(expect.any(Object), true);
    });

    it("preserves the initial release error when the recovery release also fails", async () => {
        const first = new Error("first release");
        const recovery = new Error("recovery release");
        manager.releaseSavepoint.mockRejectedValueOnce(first).mockRejectedValueOnce(recovery);
        await expect(withTestTransaction(() => fixture(() => 7))).rejects.toMatchObject({
            cause: recovery, applicationError: first,
        });
        expect(manager.rollbackToSavepoint).toHaveBeenCalledTimes(1);
        expect(manager.releaseTransaction).toHaveBeenCalledWith(expect.any(Object), true);
    });

    it.each([new Error("callback"), undefined])("retains a poisoned fixture's application failure %p alongside a later body error", async applicationError => {
        const recoveryError = new Error("savepoint rollback");
        const bodyError = new Error("body after caught failure");
        manager.rollbackToSavepoint.mockRejectedValueOnce(recoveryError);
        let broken!: unknown;
        await expect(withTestTransaction(async () => {
            try { await fixture(() => { throw applicationError; }); }
            catch (error) { broken = error; }
            throw bodyError;
        })).rejects.toMatchObject({
            cause: { cause: recoveryError, applicationError },
            applicationError: bodyError,
        });
        expect(broken).toBeInstanceOf(TransactionSystemError);
        expect(manager.releaseTransaction).toHaveBeenCalledWith(expect.any(Object), true);
    });

    it("drains a forgotten successful fixture before physical rollback and rejects the body", async () => {
        const entered = deferred();
        const gate = deferred();
        const work = withTestTransaction(() => {
            void fixture(async () => {
                entered.resolve();
                await gate.promise;
                expect(testSession(manager)!.admitting).toBe(false);
            });
            return "body completed";
        });
        await entered.promise;
        expect(manager.rollbackTransaction).not.toHaveBeenCalled();
        const assertion = expect(work).rejects.toMatchObject({
            message: "Pending fixture work drained before test rollback",
            errors: [expect.objectContaining({ message: expect.stringContaining("pending fixture work") })],
        });
        gate.resolve();
        await assertion;
        expect(manager.releaseSavepoint).toHaveBeenCalledTimes(1);
        expect(manager.rollbackTransaction).toHaveBeenCalledTimes(1);
    });

    it("aggregates pending fixture, body, fixture callback, physical rollback and release errors", async () => {
        const entered = deferred();
        const gate = deferred();
        const bodyError = new Error("body");
        const fixtureError = new Error("fixture");
        const rollbackError = new Error("physical rollback");
        const releaseError = new Error("physical release");
        manager.rollbackTransaction.mockRejectedValueOnce(rollbackError);
        manager.releaseTransaction.mockRejectedValueOnce(releaseError);
        const work = withTestTransaction(() => {
            void fixture(async () => { entered.resolve(); await gate.promise; throw fixtureError; });
            throw bodyError;
        });
        await entered.promise;
        expect(manager.rollbackTransaction).not.toHaveBeenCalled();
        const assertion = expect(work).rejects.toMatchObject({
            cause: releaseError,
            applicationError: {
                cause: rollbackError,
                applicationError: {
                    message: "Pending fixture work drained before test rollback",
                    errors: [expect.any(Error), bodyError, fixtureError],
                },
            },
        });
        gate.resolve();
        await assertion;
        expect(manager.releaseTransaction).toHaveBeenCalledWith(expect.any(Object), true);
    });
});
