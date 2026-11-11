import {
    afterCommit, afterRollback, clearTransactionManager, ctx, DatasourceSetupError, DEFAULT_DATASOURCE,
    Propagation, transactional, TransactionClosedError, TransactionSystemError, useTransactionManager,
} from "@tranjs/core";
import { withTestConnection, mockTransactions, currentProbe, TestOptions, withTestTransaction } from "../src";
import { FakeTransactionManager } from "../src/fake";
import { TestConnectionLease, testSession } from "../../core/src/internal";

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
class TestConnectionManager extends FakeTransactionManager {
    readonly query = jest.fn((operation: PromiseLike<unknown>) => operation);
    readonly createSavepoint = jest.fn(async (_tx?: object, _name?: string) => {});
    readonly rollbackToSavepoint = jest.fn(async (_tx?: object, _name?: string) => {});
    readonly releaseSavepoint = jest.fn(async (_tx?: object, _name?: string) => {});
    readonly rollbackTransaction = jest.fn(async () => {});
    readonly releaseTransaction = jest.fn(async (_tx: object, _failed: boolean) => {});
    readonly checkTestTransactionConstraints = jest.fn(async (_tx: object, _name: string) => {});
    readonly createTestConnection = jest.fn((_tx: object, lease: TestConnectionLease): Connection => ({
        query: <T>(operation: PromiseLike<T>) => lease.track(() => this.query(operation) as PromiseLike<T>),
    }));
    remainingTimeout() { return this.getRemainingTimeout(); }
}

describe("withTestConnection", () => {
    const other = Symbol("other withTestConnection datasource");
    let manager: TestConnectionManager;

    beforeEach(() => {
        manager = new TestConnectionManager();
        manager.setLogger({ error: jest.fn() } as any);
        useTransactionManager(manager);
    });

    afterEach(() => {
        clearTransactionManager();
        clearTransactionManager(other);
        jest.restoreAllMocks();
    });

    it("uses a hidden-transaction savepoint without a logical owner, deadline, probe record or constraint check", async () => {
        await withTestTransaction(async tx => {
            const mark = tx.track(jest.fn());
            tx.failNext("begin");
            tx.failNext("commit");
            tx.failNext("rollback");
            const hooks = jest.fn();
            expect(await withTestConnection(async (db: Connection) => {
                mark();
                expect(manager.getCurrentTransaction()).toBeUndefined();
                expect(manager.remainingTimeout()).toBeUndefined();
                expect(() => ctx()).toThrow("No transaction context");
                expect(currentProbe()).toBe(tx);
                afterRollback(hooks);
                const result = await db.query(Promise.resolve({ id: 7 }));
                return result;
            })).toEqual({ id: 7 });
            expect(tx.txOf(mark)).toBeUndefined();
            expect(tx.records).toEqual([]);
            expect(hooks).not.toHaveBeenCalled();
            expect(manager.checkTestTransactionConstraints).not.toHaveBeenCalled();
            const session = testSession(manager)!;
            const physical = session.context!.transaction;
            expect(manager.createTestConnection).toHaveBeenCalledWith(physical, expect.any(Object));
            expect(manager.createSavepoint).toHaveBeenCalledWith(physical, `tranjs_${session.id}_connection_1`);
            expect(manager.releaseSavepoint).toHaveBeenCalledWith(physical, `tranjs_${session.id}_connection_1`);
            expect(manager.rollbackToSavepoint).not.toHaveBeenCalled();
            expect(await withTestConnection(() => 42)).toBe(42);
            expect(manager.createSavepoint).toHaveBeenLastCalledWith(physical, `tranjs_${session.id}_connection_2`);
        });
        expect(manager.rollbackTransaction).toHaveBeenCalledTimes(1);
        expect(manager.releaseTransaction).toHaveBeenCalledWith(expect.any(Object), false);
    });

    it("selects an explicit datasource or the live named session when omitted", async () => {
        const named = new TestConnectionManager();
        useTransactionManager(named, other);
        const options: TestOptions = { datasource: other };
        await withTestTransaction(async tx => {
            expect(await withTestConnection((db: Connection) => db.query(Promise.resolve("named")), options)).toBe("named");
            expect(await withTestConnection(async (db: Connection) => {
                expect(currentProbe()).toBe(tx);
                expect(currentProbe(other)).toBe(tx);
                expect(named.getCurrentTransaction()).toBeUndefined();
                expect(manager.getCurrentTransaction()).toBeUndefined();
                expect(() => ctx()).toThrow("No transaction context");
                return db.query(Promise.resolve("inferred"));
            })).toBe("inferred");
        }, options);
        expect(named.createTestConnection).toHaveBeenCalledTimes(2);
        expect(manager.createSavepoint).not.toHaveBeenCalled();
    });

    it("uses distinct managed and connection savepoint names across concurrent and later sessions", async () => {
        const run = () => withTestTransaction(async () => {
            const session = testSession(manager)!;
            const physical = session.context!.transaction;
            await transactional(async () => {
                await transactional(() => {}, { propagation: Propagation.NESTED })();
            })();
            await withTestConnection((db: Connection) => db.query(Promise.resolve(1)));
            return { id: session.id, physical };
        });
        const sessions = [...await Promise.all([run(), run()]), await run()];
        expect(new Set(sessions.map(session => session.id)).size).toBe(3);
        const created = manager.createSavepoint.mock.calls;
        const names = created.map(([, name]) => name);
        expect(names).toHaveLength(9);
        expect(new Set(names).size).toBe(names.length);
        for (const { id, physical } of sessions) {
            const ownNames = created.filter(([transaction]) => transaction === physical).map(([, name]) => name);
            expect(ownNames).toHaveLength(3);
            expect(ownNames.filter(name => name!.startsWith(`tranjs_${id}_sp_`))).toHaveLength(2);
            expect(ownNames.filter(name => name!.startsWith(`tranjs_${id}_connection_`))).toHaveLength(1);
            for (const name of ownNames) {
                expect(manager.releaseSavepoint).toHaveBeenCalledWith(physical, name);
            }
        }
    });

    it("rejects a different registered manager without borrowing the live session or creating ambient context", async () => {
        const named = new TestConnectionManager();
        useTransactionManager(named, other);
        const denied = jest.fn();
        await withTestTransaction(async () => {
            await expect(withTestConnection(denied, { datasource: other })).rejects.toThrow("requires an active withTestTransaction callback");
            expect(manager.getCurrentTransaction()).toBeUndefined();
            expect(named.getCurrentTransaction()).toBeUndefined();
            expect(() => ctx()).toThrow("No transaction context");
            await expect(withTestConnection((db: Connection) => db.query(Promise.resolve("default")))).resolves.toBe("default");
        });
        await withTestTransaction(async () => {
            await expect(withTestConnection(denied, { datasource: DEFAULT_DATASOURCE })).rejects.toThrow("requires an active withTestTransaction callback");
            await expect(withTestConnection((db: Connection) => db.query(Promise.resolve("named")))).resolves.toBe("named");
        }, { datasource: other });
        expect(denied).not.toHaveBeenCalled();
        expect(manager.createTestConnection).toHaveBeenCalledTimes(1);
        expect(named.createTestConnection).toHaveBeenCalledTimes(1);
        expect(manager.getCurrentTransaction()).toBeUndefined();
        expect(named.getCurrentTransaction()).toBeUndefined();
    });

    it("rejects outside a session and for an unregistered datasource as promises", async () => {
        const callback = jest.fn();
        await expect(withTestConnection(callback)).rejects.toThrow("requires an active withTestTransaction callback");
        await withTestTransaction(async () => {
            await expect(withTestConnection(callback, { datasource: other })).rejects.toBeInstanceOf(DatasourceSetupError);
            useTransactionManager(new TestConnectionManager(), other);
            await expect(withTestConnection(callback, { datasource: other })).rejects.toThrow("requires an active withTestTransaction callback");
        });
        expect(callback).not.toHaveBeenCalled();
        expect(manager.createSavepoint).not.toHaveBeenCalled();
    });

    it("rejects mock sessions before invoking the callback", async () => {
        const callback = jest.fn();
        await mockTransactions(async () => {
            await expect(withTestConnection(callback)).rejects.toThrow("unavailable in mockTransactions");
        });
        expect(callback).not.toHaveBeenCalled();
    });

    it("keeps the default fake unsupported and recovers its withTestConnection savepoint", async () => {
        const fake = new FakeTransactionManager();
        useTransactionManager(fake);
        const rollback = jest.spyOn(fake as any, "rollbackToSavepoint");
        const release = jest.spyOn(fake as any, "releaseSavepoint");
        const callback = jest.fn();
        await withTestTransaction(async () => {
            await expect(withTestConnection(callback)).rejects.toThrow("does not support withTestConnection");
            await expect(transactional(() => 7)()).resolves.toBe(7);
        });
        expect(callback).not.toHaveBeenCalled();
        expect(rollback).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledWith(expect.any(Object), expect.stringMatching(/^tranjs_.+_connection_1$/));
    });

    it("rejects retained work after the session closes", async () => {
        const gate = deferred();
        const callback = jest.fn();
        let retained!: Promise<void>;
        await withTestTransaction(() => {
            retained = gate.promise.then(async () => {
                await expect(withTestConnection(callback)).rejects.toThrow(TransactionClosedError);
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
            await expect(withTestConnection(callback)).rejects.toThrow("initialization is still in progress");
            session.lifecycle = "ready";
            const context = session.context;
            session.context = undefined;
            await expect(withTestConnection(callback)).rejects.toThrow("initialization is still in progress");
            session.context = context;
            const error = new Error("begin failed");
            session.lifecycle = "failed";
            session.initializationError = error;
            await expect(withTestConnection(callback)).rejects.toMatchObject({ message: "Test transaction initialization failed", cause: error });
            session.lifecycle = "ready";
            session.admitting = false;
            await expect(withTestConnection(callback)).rejects.toThrow("withTestConnection was called after the withTestTransaction callback finished");
            session.admitting = true;
        });
        expect(callback).not.toHaveBeenCalled();
        expect(manager.createSavepoint).not.toHaveBeenCalled();
    });

    it("reserves withTestConnection admission synchronously before awaiting savepoint creation", async () => {
        const savepoint = deferred();
        manager.createSavepoint.mockImplementationOnce(() => savepoint.promise);
        const callback = jest.fn(() => "first");
        const denied = jest.fn();
        await withTestTransaction(async () => {
            const first = withTestConnection(callback);
            expect(testSession(manager)!.testConnectionActive).toBe(true);
            expect(callback).not.toHaveBeenCalled();
            await expect(withTestConnection(denied)).rejects.toThrow("withTestConnection overlaps another connection callback or transaction");
            await expect(transactional(denied)()).rejects.toThrow("A transaction overlaps an active withTestConnection callback");
            savepoint.resolve();
            expect(await first).toBe("first");
            expect(testSession(manager)!.testConnectionActive).toBe(false);
            expect(await withTestConnection(() => "next")).toBe("next");
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
                await expect(withTestConnection(callback)).rejects.toThrow("withTestConnection overlaps another connection callback or transaction");
                await entered.promise;
                gate.resolve();
                await work;
                await withTestConnection(() => "recovered");
            });
            expect(callback).not.toHaveBeenCalled();
        },
    );

    it("checks every shared admission gate independently", async () => {
        await withTestTransaction(async () => {
            const session = testSession(manager)!;
            session.managedActive = 1;
            await expect(withTestConnection(() => {})).rejects.toThrow("withTestConnection overlaps another connection callback or transaction");
            session.managedActive = 0;
            session.testConnectionActive = true;
            await expect(withTestConnection(() => {})).rejects.toThrow("withTestConnection overlaps another connection callback or transaction");
            session.testConnectionActive = false;
            session.root.open = true;
            await expect(withTestConnection(() => {})).rejects.toThrow("withTestConnection overlaps another connection callback or transaction");
            session.root.open = false;
        });
        expect(manager.createSavepoint).not.toHaveBeenCalled();
    });

    it.each(Object.values(Propagation))("centrally denies %s inside a withTestConnection, including another datasource", async propagation => {
        const secondary = new TestConnectionManager();
        useTransactionManager(secondary, other);
        const denied = jest.fn();
        await withTestTransaction(async () => {
            await withTestConnection(async () => {
                await Promise.resolve();
                for (const datasource of [undefined, other]) {
                    await expect(transactional(denied, { propagation, datasource })()).rejects.toThrow("A transaction cannot start inside a withTestConnection callback");
                }
                await expect(secondary.executeTransaction(propagation, denied)).rejects.toThrow("A transaction cannot start inside a withTestConnection callback");
                await expect(withTestConnection(denied)).rejects.toThrow("withTestConnection was called inside another connection callback, a transaction callback or a transaction hook");
            });
        });
        expect(denied).not.toHaveBeenCalled();
        expect(secondary.createSavepoint).not.toHaveBeenCalled();
    });

    it("retains withTestConnection provenance in delayed continuations after the overlap gate closes", async () => {
        const gate = deferred();
        const denied = jest.fn();
        let retained!: Promise<void>;
        await withTestTransaction(async () => {
            await withTestConnection(() => {
                retained = gate.promise.then(async () => {
                    await expect(transactional(denied, { propagation: Propagation.SUPPORTS })()).rejects.toThrow("A transaction cannot start inside a withTestConnection callback");
                    await expect(withTestConnection(denied)).rejects.toThrow("withTestConnection was called inside another connection callback, a transaction callback or a transaction hook");
                });
            });
            expect(testSession(manager)!.testConnectionActive).toBe(false);
            gate.resolve();
            await retained;
        });
        expect(denied).not.toHaveBeenCalled();
    });

    it("forbids withTestConnection entry from managed callbacks, rollback/commit hooks and retained hook continuations", async () => {
        const denied = jest.fn();
        const resume = deferred();
        let rollbackCalls = 0;
        let rollbackResult: PromiseSettledResult<unknown> | undefined;
        let retained!: Promise<PromiseSettledResult<unknown>[]>;
        const rollbackHook = async () => {
            rollbackCalls++;
            [rollbackResult] = await Promise.allSettled([withTestConnection(denied)]);
            retained = resume.promise.then(() => Promise.allSettled([withTestConnection(denied)]));
        };
        await withTestTransaction(async () => {
            await transactional(async () => {
                await expect(withTestConnection(denied)).rejects.toThrow("withTestConnection was called inside another connection callback, a transaction callback or a transaction hook");
                afterCommit(async () => {
                    await expect(withTestConnection(denied)).rejects.toThrow("withTestConnection was called inside another connection callback, a transaction callback or a transaction hook");
                });
            })();
            const error = new Error("owner rollback");
            await expect(transactional(() => {
                afterRollback(rollbackHook);
                throw error;
            })()).rejects.toBe(error);
            expect(rollbackCalls).toBe(1);
            expect(rollbackResult).toMatchObject({
                status: "rejected", reason: { message: "withTestConnection was called inside another connection callback, a transaction callback or a transaction hook" },
            });
            expect(testSession(manager)!.root.open).toBe(false);
            expect(testSession(manager)!.managedActive).toBe(0);
            await withTestConnection(() => 1);
            resume.resolve();
            const [retainedResult] = await retained;
            expect(retainedResult).toMatchObject({
                status: "rejected", reason: { message: "withTestConnection was called inside another connection callback, a transaction callback or a transaction hook" },
            });
            await afterCommit(async () => {
                await Promise.resolve();
                await expect(withTestConnection(denied)).rejects.toThrow("withTestConnection was called inside another connection callback, a transaction callback or a transaction hook");
            });
            await withTestConnection(async () => {
                await afterCommit(async () => {
                    await expect(withTestConnection(denied)).rejects.toThrow("withTestConnection was called inside another connection callback, a transaction callback or a transaction hook");
                });
            });
            await withTestConnection(() => 1);
        });
        expect(denied).not.toHaveBeenCalled();
        expect(rollbackCalls).toBe(1);
    });

    it.each([new Error("callback"), undefined, null, "callback failure"])("rolls back callback failure %p without poisoning the session", async error => {
        await withTestTransaction(async () => {
            await expect(withTestConnection(() => { throw error; })).rejects.toBe(error);
            expect(manager.rollbackToSavepoint).toHaveBeenCalledWith(expect.any(Object), expect.stringMatching(/^tranjs_.+_connection_1$/));
            expect(manager.releaseSavepoint).toHaveBeenCalledTimes(1);
            await expect(withTestConnection(() => "recovered")).resolves.toBe("recovered");
        });
        expect(manager.releaseTransaction).toHaveBeenCalledWith(expect.any(Object), false);
    });

    it("reports a caught query failure and deduplicates a query rejection also thrown by the callback", async () => {
        const error = new Error("query");
        await withTestTransaction(async () => {
            await expect(withTestConnection(async (db: Connection) => {
                await expect(db.query(Promise.reject(error))).rejects.toBe(error);
                return "caught";
            })).rejects.toBe(error);
            await expect(withTestConnection((db: Connection) => db.query(Promise.reject(error)))).rejects.toBe(error);
            await withTestConnection(() => "recovered");
        });
        expect(manager.rollbackToSavepoint).toHaveBeenCalledTimes(2);
    });

    it("finalizes already-resolved native query promises normally without waiting for callback bookkeeping", async () => {
        await withTestTransaction(async () => {
            await expect(withTestConnection((db: Connection) => {
                void db.query(Promise.resolve(7));
                return "callback completed";
            })).resolves.toBe("callback completed");
            const native = Promise.resolve(8);
            await expect(withTestConnection((db: Connection) => {
                const query = db.query(native);
                expect(query).toBe(native);
                return query;
            })).resolves.toBe(8);
            expect(manager.releaseSavepoint).toHaveBeenCalledTimes(2);
            expect(manager.rollbackToSavepoint).not.toHaveBeenCalled();
        });
        expect(manager.rollbackTransaction).toHaveBeenCalledTimes(1);
    });

    it("aggregates distinct callback and settled query failures", async () => {
        const queryError = new Error("query");
        const callbackError = new Error("callback");
        await withTestTransaction(async () => {
            await expect(withTestConnection(async (db: Connection) => {
                await db.query(Promise.reject(queryError)).catch(() => {});
                throw callbackError;
            })).rejects.toMatchObject({
                message: "withTestConnection callback and query work failed",
                errors: [callbackError, queryError],
            });
        });
    });

    it("recovers a synchronous query-adapter exception", async () => {
        const error = new Error("synchronous query failure");
        manager.query.mockImplementationOnce(() => { throw error; });
        await withTestTransaction(async () => {
            await expect(withTestConnection((db: Connection) => db.query(Promise.resolve(1)))).rejects.toBe(error);
            await expect(withTestConnection((db: Connection) => db.query(Promise.resolve(2)))).resolves.toBe(2);
        });
        expect(manager.rollbackToSavepoint).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])("revokes the connection and waits for unawaited queries before recovery (query fails: %s)", async fails => {
        const query = deferred<number>();
        const returned = deferred();
        const queryError = new Error("late query");
        let connection!: Connection;
        await withTestTransaction(async () => {
            const work = withTestConnection((db: Connection) => {
                connection = db;
                void db.query(query.promise);
                returned.resolve();
                return "callback done";
            });
            await returned.promise;
            // Let the executor observe callback completion, not just callback entry.
            await Promise.resolve();
            await Promise.resolve();
            expect(() => connection.query(Promise.resolve(0))).toThrow("The connection was used after its withTestConnection callback finished");
            expect(manager.rollbackToSavepoint).not.toHaveBeenCalled();
            expect(manager.releaseSavepoint).not.toHaveBeenCalled();
            const assertion = fails
                ? expect(work).rejects.toMatchObject({ errors: [queryError, expect.objectContaining({ message: expect.stringContaining("pending query work") })] })
                : expect(work).rejects.toThrow("pending query work");
            if (fails) query.reject(queryError);
            else query.resolve(7);
            await assertion;
            expect(manager.rollbackToSavepoint).toHaveBeenCalledTimes(1);
            await withTestConnection(() => "recovered");
        });
        expect(manager.query).toHaveBeenCalledTimes(1);
    });

    it("waits for multiple unawaited queries and retains a callback failure including undefined", async () => {
        const first = deferred();
        const second = deferred();
        const returned = deferred();
        const queryError = new Error("query");
        await withTestTransaction(async () => {
            const work = withTestConnection((db: Connection) => {
                void db.query(first.promise);
                void db.query(second.promise);
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
            await expect(withTestConnection((db: Connection) => {
                retained = db;
                return asynchronous ? Promise.resolve(db) : db;
            })).rejects.toThrow("withTestConnection returned its connection");
            expect(() => retained.query(Promise.resolve(1))).toThrow("The connection was used after its withTestConnection callback finished");
            await withTestConnection(() => "recovered");
        });
        expect(manager.query).not.toHaveBeenCalled();
        expect(manager.rollbackToSavepoint).toHaveBeenCalledTimes(1);
    });

    it("does not deep-scan returned data, invoke getters or permit a nested facade to outlive the lease", async () => {
        const getter = jest.fn(() => { throw new Error("must not inspect data"); });
        await withTestTransaction(async () => {
            const result = await withTestConnection((db: Connection) => {
                const data = { nested: [db], value: 7 };
                Object.defineProperty(data, "untouched", { get: getter });
                return data;
            });
            expect(result.value).toBe(7);
            expect(getter).not.toHaveBeenCalled();
            expect(() => result.nested[0].query(Promise.resolve(1))).toThrow("The connection was used after its withTestConnection callback finished");
        });
        expect(manager.rollbackToSavepoint).not.toHaveBeenCalled();
        expect(manager.query).not.toHaveBeenCalled();
    });

    it.each([new Error("create savepoint"), undefined])("poisons the session if savepoint creation throws %p", async error => {
        manager.createSavepoint.mockRejectedValueOnce(error);
        const callback = jest.fn();
        await expect(withTestTransaction(async () => {
            await expect(withTestConnection(callback)).rejects.toBe(error);
            await expect(withTestConnection(callback)).rejects.toThrow("The test transaction could not be restored");
            await expect(transactional(callback)()).rejects.toThrow("The test transaction could not be restored");
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
            await expect(withTestConnection(() => 7)).rejects.toBe(error);
            expect(manager.rollbackToSavepoint).toHaveBeenCalledTimes(1);
            expect(manager.releaseSavepoint).toHaveBeenCalledTimes(2);
            await expect(withTestConnection(() => "recovered")).resolves.toBe("recovered");
        });
        expect(manager.releaseTransaction).toHaveBeenCalledWith(expect.any(Object), false);
    });

    it.each(["rollback", "release"])("poisons on withTestConnection recovery %s failure and preserves the application error", async operation => {
        const applicationError = new Error("callback");
        const recoveryError = new Error(operation);
        if (operation === "rollback") manager.rollbackToSavepoint.mockRejectedValueOnce(recoveryError);
        else manager.releaseSavepoint.mockRejectedValueOnce(recoveryError);
        let broken!: unknown;
        const work = withTestTransaction(async () => {
            try { await withTestConnection(() => { throw applicationError; }); }
            catch (error) { broken = error; }
            expect(broken).toBeInstanceOf(TransactionSystemError);
            expect(broken).toMatchObject({ cause: recoveryError, applicationError });
            await expect(withTestConnection(() => 1)).rejects.toThrow("The test transaction could not be restored");
        });
        const result = await work.catch(error => error);
        expect(result).toBe(broken);
        expect(manager.releaseTransaction).toHaveBeenCalledWith(expect.any(Object), true);
    });

    it("preserves the initial release error when the recovery release also fails", async () => {
        const first = new Error("first release");
        const recovery = new Error("recovery release");
        manager.releaseSavepoint.mockRejectedValueOnce(first).mockRejectedValueOnce(recovery);
        await expect(withTestTransaction(() => withTestConnection(() => 7))).rejects.toMatchObject({
            cause: recovery, applicationError: first,
        });
        expect(manager.rollbackToSavepoint).toHaveBeenCalledTimes(1);
        expect(manager.releaseTransaction).toHaveBeenCalledWith(expect.any(Object), true);
    });

    it.each([new Error("callback"), undefined])("retains a poisoned withTestConnection's application failure %p alongside a later body error", async applicationError => {
        const recoveryError = new Error("savepoint rollback");
        const bodyError = new Error("body after caught failure");
        manager.rollbackToSavepoint.mockRejectedValueOnce(recoveryError);
        let broken!: unknown;
        await expect(withTestTransaction(async () => {
            try { await withTestConnection(() => { throw applicationError; }); }
            catch (error) { broken = error; }
            throw bodyError;
        })).rejects.toMatchObject({
            cause: { cause: recoveryError, applicationError },
            applicationError: bodyError,
        });
        expect(broken).toBeInstanceOf(TransactionSystemError);
        expect(manager.releaseTransaction).toHaveBeenCalledWith(expect.any(Object), true);
    });

    it("does not wait for a forgotten never-settling connection callback and revokes its cached facade", async () => {
        const entered = deferred();
        let connection!: Connection;
        await expect(withTestTransaction(async () => {
            void withTestConnection((db: Connection) => {
                connection = db;
                entered.resolve();
                return new Promise<void>(() => {});
            });
            await entered.promise;
            return "body completed";
        })).resolves.toBe("body completed");
        expect(() => connection.query(Promise.resolve(1))).toThrow(TransactionClosedError);
        expect(() => connection.query(Promise.resolve(1))).toThrow("Transaction already finished");
        expect(manager.query).not.toHaveBeenCalled();
        expect(manager.releaseSavepoint).not.toHaveBeenCalled();
        expect(manager.rollbackToSavepoint).not.toHaveBeenCalled();
        expect(manager.rollbackTransaction).toHaveBeenCalledTimes(1);
        expect(manager.releaseTransaction).toHaveBeenCalledWith(expect.any(Object), false);
    });

    it.each([false, true])("rejects a connection callback finishing after root closure without cleanup SQL (callback fails: %s)", async fails => {
        const entered = deferred();
        const resume = deferred();
        const connectionError = new Error("withTestConnection");
        let operation!: Promise<void>;
        await expect(withTestTransaction(async () => {
            operation = withTestConnection(async () => {
                entered.resolve();
                await resume.promise;
                if (fails) throw connectionError;
            });
            await entered.promise;
            return "body completed";
        })).resolves.toBe("body completed");
        expect(manager.rollbackTransaction).toHaveBeenCalledTimes(1);
        expect(manager.releaseTransaction).toHaveBeenCalledWith(expect.any(Object), false);
        const assertion = expect(operation).rejects.toThrow(TransactionClosedError);
        resume.resolve();
        await assertion;
        expect(manager.rollbackToSavepoint).not.toHaveBeenCalled();
        expect(manager.releaseSavepoint).not.toHaveBeenCalled();
    });
});
