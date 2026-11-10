import {
    afterCommit, afterRollback, clearTransactionManager, DatasourceSetupError, DEFAULT_DATASOURCE,
    getTransactionManager, IllegalTransactionStateException, IsolationLevel, Propagation, runInTransaction,
    Transactional, TransactionSystemError, useTransactionManager,
} from "../src";
import { mockTransactions, TestTransactionInfo, TestTransactionProbe, withTestTransaction } from "../src/testing";
import { FakeTransactionManager } from "../src/testing/fake";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

describe("mockTransactions", () => {
    afterEach(() => {
        clearTransactionManager();
        jest.restoreAllMocks();
    });

    it("returns sync and async results and restores an existing registration", async () => {
        const original = new FakeTransactionManager();
        useTransactionManager(original);
        expect(await mockTransactions(t => {
            expect(t.datasource).toBe(DEFAULT_DATASOURCE);
            expect(getTransactionManager()).not.toBe(original);
            return 42;
        })).toBe(42);
        expect(getTransactionManager()).toBe(original);
        expect(await mockTransactions(async () => "async")).toBe("async");
        expect(getTransactionManager()).toBe(original);
    });

    it.each([new Error("application"), undefined, null, "plain value"])("restores after throwing %p", async error => {
        const original = new FakeTransactionManager();
        useTransactionManager(original);
        await expect(mockTransactions(() => { throw error; })).rejects.toBe(error);
        expect(getTransactionManager()).toBe(original);
    });

    it("clears a temporary named registration after throwing", async () => {
        const datasource = Symbol("temporary");
        const error = new Error("application");
        await expect(mockTransactions(t => {
            expect(t.datasource).toBe(datasource);
            throw error;
        }, { datasource })).rejects.toBe(error);
        expect(() => getTransactionManager(datasource)).toThrow(DatasourceSetupError);
    });

    it("preserves mock inspection, implementation, this, arguments and return values when tracking", async () => {
        await mockTransactions(async t => {
            const save = jest.fn(function(this: { prefix: string }, value: number) {
                return `${this.prefix}:${value}`;
            });
            const repository = t.track({ prefix: "saved", save });
            expect(jest.isMockFunction(repository.save)).toBe(true);
            expect(await runInTransaction(() => repository.save(7))).toBe("saved:7");
            expect(repository.save).toHaveBeenCalledWith(7);
            expect(repository.save.mock.calls).toEqual([[7]]);
            expect(save).toHaveBeenCalledTimes(1);
            expect(t.txOf(repository.save)).toBe(t.transactions[0]);
            repository.save.mockImplementation(value => `changed:${value}`);
            expect(repository.save(8)).toBe("changed:8");
            expect(t.txOf(repository.save, 1)).toBeUndefined();
        });
    });

    it("tracks standalone functions and distinguishes calls outside a transaction", async () => {
        await mockTransactions(async t => {
            const work = t.track(jest.fn((value: number) => value * 2));
            expect(work(2)).toBe(4);
            await runInTransaction(() => work(3));
            await runInTransaction(() => work(4));
            expect(t.txOf(work)).toBeUndefined();
            expect(t.txOf(work, 1)).toBe(t.transactions[0]);
            expect(t.txOf(work, 2)).toBe(t.transactions[1]);
            expect(t.transactions[0].id).not.toBe(t.transactions[1].id);
        });
    });

    it("tracks prototype methods without changing instance state or return types", async () => {
        class Repository {
            total = 0;
            save(amount: number) { this.total += amount; return this.total; }
        }
        await mockTransactions(async t => {
            const repository = t.track(new Repository());
            expect(await runInTransaction(() => repository.save(3))).toBe(3);
            expect(repository.total).toBe(3);
            expect(t.txOf(repository.save)).toBe(t.transactions[0]);
            expect(t.txOf(repository.save)!.outcome).toBe("committed");
        });
    });

    it("rejects untracked functions and missing calls rather than treating them as outside calls", async () => {
        await mockTransactions(t => {
            const work = t.track(jest.fn());
            expect(() => t.txOf(jest.fn())).toThrow("not tracked");
            expect(() => t.txOf(work)).toThrow(RangeError);
            work();
            expect(t.txOf(work)).toBeUndefined();
            for (const call of [-1, 1, 0.5, NaN]) {
                expect(() => t.txOf(work, call)).toThrow(RangeError);
            }
        });
    });

    it("supports methods and getters that access class private fields", async () => {
        class Repository {
            #total = 0;
            get total() { return this.#total; }
            save(amount: number) { this.#total += amount; return this.#total; }
        }
        await mockTransactions(async t => {
            const original = new Repository();
            const repository = t.track(original);
            expect(await runInTransaction(() => repository.save(3))).toBe(3);
            expect(repository.total).toBe(3);
            expect(original.total).toBe(3);
            expect(t.txOf(repository.save)).toBe(t.transactions[0]);
        });
    });

    it("uses the original object as this for tracked methods and getters", async () => {
        await mockTransactions(async t => {
            const original = {
                save(): object { return this; },
                get receiver(): object { return this; },
            };
            const repository = t.track(original);
            expect(await runInTransaction(() => repository.save())).toBe(original);
            expect(repository.receiver).toBe(original);
            expect(t.txOf(repository.save)).toBe(t.transactions[0]);
        });
    });

    it("preserves an explicit call receiver for a standalone tracked function", async () => {
        await mockTransactions(async t => {
            const receiver = { prefix: "saved" };
            const work = t.track(function(this: typeof receiver, value: number) {
                expect(this).toBe(receiver);
                return `${this.prefix}:${value}`;
            });
            expect(await runInTransaction(() => work.call(receiver, 7))).toBe("saved:7");
            expect(t.txOf(work)).toBe(t.transactions[0]);
        });
    });

    it("tracks methods on a frozen object through the returned wrapper", async () => {
        await mockTransactions(async t => {
            const original = Object.freeze({ save(value: number) { return value + 1; } });
            const repository = t.track(original);
            expect(await runInTransaction(() => repository.save(7))).toBe(8);
            expect(Object.isFrozen(original)).toBe(true);
            expect(t.txOf(repository.save)).toBe(t.transactions[0]);
        });
    });

    it("keeps fluent Jest mock configuration on the tracked standalone wrapper", async () => {
        await mockTransactions(async t => {
            const original = jest.fn(async (value: number) => value);
            const work = t.track(original);
            expect(work.mockReturnValue(Promise.resolve(10))).toBe(work);
            expect(await runInTransaction(() => work(1))).toBe(10);
            expect(work.mockResolvedValue(20)).toBe(work);
            expect(await runInTransaction(() => work(2))).toBe(20);
            expect(work.mockImplementation(async value => value * 10)).toBe(work);
            expect(await runInTransaction(() => work(3))).toBe(30);
            expect(original.mock.calls).toEqual([[1], [2], [3]]);
            for (let call = 0; call < 3; call++) {
                expect(t.txOf(work, call)).toBe(t.transactions[call]);
            }
            expect(() => t.txOf(work, 3)).toThrow(RangeError);
        });
    });

    it("shares identity for joined and NESTED scopes and records physical owner options and outcomes", async () => {
        await mockTransactions(async t => {
            const mark = t.track(jest.fn());
            const options = { isolationLevel: IsolationLevel.SERIALIZABLE, readOnly: true, timeout: 1000 };
            await runInTransaction(async () => {
                mark();
                const owner = t.txOf(mark)!;
                expect(owner.outcome).toBe("active");
                expect(owner.parent).toBeUndefined();
                expect(owner.options).toEqual(options);
                expect(owner.propagation).toBe(Propagation.REQUIRED);
                for (const propagation of [Propagation.REQUIRED, Propagation.MANDATORY, Propagation.SUPPORTS, Propagation.NESTED]) {
                    await runInTransaction(() => {
                        mark();
                        expect(t.txOf(mark, mark.mock.calls.length - 1)).toBe(owner);
                    }, { propagation });
                }
                await expect(runInTransaction(() => { throw new Error("savepoint"); }, {
                    propagation: Propagation.NESTED,
                })).rejects.toThrow("savepoint");
                expect(owner.outcome).toBe("active");
            }, options);
            expect(t.transactions).toHaveLength(1);
            expect(t.txOf(mark)!.outcome).toBe("committed");
            await expect(runInTransaction(() => { throw new Error("rollback"); })).rejects.toThrow("rollback");
            expect(t.transactions.map(info => info.outcome)).toEqual(["committed", "rolled-back"]);
        });
    });

    it("uses the active logical owner as parent, including suspended and restored boundaries", async () => {
        await mockTransactions(async t => {
            const mark = t.track(jest.fn());
            await runInTransaction(async () => {
                mark();
                const outer = t.txOf(mark)!;
                await runInTransaction(async () => {
                    mark();
                    const inner = t.txOf(mark, 1)!;
                    expect(inner).not.toBe(outer);
                    expect(inner.parent).toBe(outer);
                    expect(inner.propagation).toBe(Propagation.REQUIRES_NEW);
                    await runInTransaction(() => {
                        mark();
                        expect(t.txOf(mark, 2)!.parent).toBe(inner);
                    }, { propagation: Propagation.REQUIRES_NEW });
                }, { propagation: Propagation.REQUIRES_NEW });
                await runInTransaction(async () => {
                    mark();
                    expect(t.txOf(mark, 3)).toBeUndefined();
                    await runInTransaction(() => {
                        mark();
                        expect(t.txOf(mark, 4)!.parent).toBeUndefined();
                    });
                }, { propagation: Propagation.NOT_SUPPORTED });
                await runInTransaction(() => {
                    mark();
                    expect(t.txOf(mark, 5)!.parent).toBe(outer);
                }, { propagation: Propagation.REQUIRES_NEW });
                mark();
                expect(t.txOf(mark, 6)).toBe(outer);
            });
            expect(t.transactions).toHaveLength(5);
            expect(t.transactions.every(info => info.outcome === "committed")).toBe(true);
        });
    });

    it("rejects overlapping mocks for the same datasource without disturbing the active mock", async () => {
        const entered = deferred();
        const release = deferred();
        const callback = jest.fn();
        const active = mockTransactions(async () => {
            const manager = getTransactionManager();
            entered.resolve();
            await release.promise;
            expect(getTransactionManager()).toBe(manager);
        });
        await entered.promise;
        try {
            await expect(mockTransactions(callback)).rejects.toThrow();
            expect(callback).not.toHaveBeenCalled();
        } finally { release.resolve(); }
        await active;
        expect(() => getTransactionManager()).toThrow(DatasourceSetupError);
        await expect(mockTransactions(() => 7)).resolves.toBe(7);
    });

    it("blocks retained native Promise work after restoring the original manager without blocking the caller", async () => {
        const original = new FakeTransactionManager();
        useTransactionManager(original);
        const begin = jest.spyOn(original as any, "beginTransaction");
        const callback = jest.fn(() => 42);
        let release!: () => void;
        let retained!: Promise<void>;
        await mockTransactions(() => {
            const gate = new Promise<void>(resolve => { release = resolve; });
            retained = gate.then(async () => {
                expect(getTransactionManager()).toBe(original);
                for (const propagation of Object.values(Propagation)) {
                    await expect(runInTransaction(callback, { propagation })).rejects.toThrow("closed or broken");
                }
            });
        });
        expect(getTransactionManager()).toBe(original);
        release();
        await retained;
        expect(begin).not.toHaveBeenCalled();
        expect(callback).not.toHaveBeenCalled();
        // This continuation was not created inside the mock's ALS context.
        await expect(runInTransaction(callback)).resolves.toBe(42);
        expect(begin).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledTimes(1);
    });

    it("allows an active named mock to use another datasource's registered manager", async () => {
        const original = new FakeTransactionManager();
        useTransactionManager(original);
        const begin = jest.spyOn(original as any, "beginTransaction");
        const datasource = Symbol("active named mock");
        await mockTransactions(async t => {
            await expect(runInTransaction(() => 42)).resolves.toBe(42);
            const work = t.track(jest.fn());
            await runInTransaction(work, { datasource });
            expect(t.txOf(work)!.outcome).toBe("committed");
        }, { datasource });
        expect(begin).toHaveBeenCalledTimes(1);
        expect(getTransactionManager()).toBe(original);
    });

    it("allows concurrent mocks on distinct datasources", async () => {
        const names = [Symbol("first"), Symbol("second")];
        await Promise.all(names.map(datasource => mockTransactions(async t => {
            const work = t.track(jest.fn());
            await Promise.resolve();
            await runInTransaction(work, { datasource });
            expect(t.datasource).toBe(datasource);
            expect(t.txOf(work)!.outcome).toBe("committed");
            expect(t.transactions).toHaveLength(1);
        }, { datasource })));
        names.forEach(name => expect(() => getTransactionManager(name)).toThrow(DatasourceSetupError));
    });
});

describe("failure selectors", () => {
    afterEach(() => clearTransactionManager());

    it("selects commits containing a tracked call, without failing unrelated transactions", async () => {
        await mockTransactions(async t => {
            const selected = t.track(jest.fn());
            const unrelated = t.track(jest.fn());
            const error = new Error("selected commit");
            t.fail("commit", { containing: selected, error });
            await runInTransaction(unrelated);
            await expect(runInTransaction(selected)).rejects.toBe(error);
            await runInTransaction(selected);
            expect(t.txOf(unrelated)!.outcome).toBe("committed");
            expect(t.txOf(selected)!.outcome).not.toBe("committed");
            expect(t.txOf(selected, 1)!.outcome).toBe("committed");
        });
    });

    it("selects by transaction options, consuming times only for matching transactions", async () => {
        await mockTransactions(async t => {
            const work = t.track(jest.fn());
            const error = new Error("read-only commit");
            t.fail("commit", { where: info => info.options.readOnly === true, times: 2, error });
            await runInTransaction(work);
            await runInTransaction(() => {});
            await expect(runInTransaction(work, { readOnly: true })).rejects.toBe(error);
            await runInTransaction(work);
            await expect(runInTransaction(work, { readOnly: true })).rejects.toBe(error);
            await runInTransaction(work, { readOnly: true });
            expect(t.txOf(work, 0)!.outcome).toBe("committed");
            expect(t.txOf(work, 2)!.outcome).toBe("committed");
            expect(t.txOf(work, 4)!.outcome).toBe("committed");
        });
    });

    it("limits containing selectors to the requested number of matching commits", async () => {
        await mockTransactions(async t => {
            const selected = t.track(jest.fn());
            const unrelated = t.track(jest.fn());
            const error = new Error("selected twice");
            t.fail("commit", { containing: selected, times: 2, error });
            await runInTransaction(unrelated);
            await expect(runInTransaction(selected)).rejects.toBe(error);
            await runInTransaction(unrelated);
            await expect(runInTransaction(selected)).rejects.toBe(error);
            await runInTransaction(selected);
            expect(t.txOf(selected)!.outcome).toBe("rolled-back");
            expect(t.txOf(selected, 1)!.outcome).toBe("rolled-back");
            expect(t.txOf(selected, 2)!.outcome).toBe("committed");
            expect(t.txOf(unrelated)!.outcome).toBe("committed");
            expect(t.txOf(unrelated, 1)!.outcome).toBe("committed");
        });
    });

    it("rejects ambiguous selectors and containing selectors that cannot match a begin", async () => {
        await mockTransactions(t => {
            const work = t.track(jest.fn());
            expect(() => t.fail("commit", { containing: work, where: () => true })).toThrow(TypeError);
            expect(() => t.fail("begin", { containing: work })).toThrow("has not run yet");
            expect(() => t.fail("commit", { containing: jest.fn() })).toThrow("not tracked");
            for (const times of [0, -1, 0.5, NaN, Infinity]) {
                expect(() => t.fail("commit", { times })).toThrow(RangeError);
            }
        });
    });

    it("injects begin failures before calling application code and leaves subsequent transactions usable", async () => {
        await mockTransactions(async t => {
            const work = t.track(jest.fn());
            const error = new Error("begin failed");
            t.fail("begin", { where: info => info.options.readOnly === true, times: 2, error });
            await runInTransaction(work);
            await expect(runInTransaction(work, { readOnly: true })).rejects.toBe(error);
            await expect(runInTransaction(work, { readOnly: true })).rejects.toBe(error);
            expect(work).toHaveBeenCalledTimes(1);
            await runInTransaction(work, { readOnly: true });
            expect(work).toHaveBeenCalledTimes(2);
            expect(t.txOf(work, 1)!.outcome).toBe("committed");
        });
    });

    it("selects rollback failures and retains application error metadata", async () => {
        await mockTransactions(async t => {
            getTransactionManager().setLogger({ info() {}, warn() {}, error() {}, debug() {} });
            const work = t.track(jest.fn());
            const applicationError = new Error("application");
            const error = new Error("rollback failed");
            t.fail("rollback", { containing: work, error });
            const fail = () => runInTransaction(() => { work(); throw applicationError; });
            await expect(fail()).rejects.toBeInstanceOf(TransactionSystemError);
            // The selected failure is one-shot, so the original error survives the next rollback.
            await expect(fail()).rejects.toBe(applicationError);
            expect(t.txOf(work, 1)!.outcome).toBe("rolled-back");
        });
    });

    it.each(["mock", "integration"])("consumes rollback selectors during %s commit recovery, not a later rollback", async mode => {
        const manager = new FakeTransactionManager();
        manager.setLogger({ info() {}, warn() {}, error() {}, debug() {} });
        useTransactionManager(manager);
        const nativeRollback = jest.spyOn(manager as any, "rollbackToSavepoint");
        const nativeRelease = jest.spyOn(manager as any, "releaseSavepoint");
        const execute = mode === "mock" ? mockTransactions : withTestTransaction;
        await execute(async t => {
            getTransactionManager().setLogger({ info() {}, warn() {}, error() {}, debug() {} });
            const selected = t.track(jest.fn());
            const unrelated = t.track(jest.fn());
            const commitError = new Error("commit failed");
            const rollbackError = new Error("recovery rollback failed");
            const laterError = new Error("later application error");
            t.fail("commit", { containing: selected, times: 2, error: commitError });
            t.fail("rollback", { containing: selected, error: rollbackError });
            t.fail("rollback", { where: info => info.options.readOnly === true, error: rollbackError });
            for (const readOnly of [false, true]) {
                const result = runInTransaction(selected, { readOnly });
                await expect(result).rejects.toBeInstanceOf(TransactionSystemError);
                await expect(result).rejects.toMatchObject({ cause: rollbackError, applicationError: commitError });
            }
            expect(t.txOf(selected)!.outcome).toBe("rolled-back");
            expect(t.txOf(selected, 1)!.outcome).toBe("rolled-back");
            await expect(runInTransaction(() => { unrelated(); throw laterError; }, { readOnly: true })).rejects.toBe(laterError);
            // A consumed containing rule must not hit the same function later either.
            await expect(runInTransaction(() => { selected(); throw laterError; })).rejects.toBe(laterError);
            await runInTransaction(unrelated);
        });
        if (mode === "integration") {
            expect(nativeRollback).toHaveBeenCalledTimes(4);
            expect(nativeRelease).toHaveBeenCalledTimes(5);
        }
        jest.restoreAllMocks();
    });

    it("supplies a default failure when no selector is given", async () => {
        await mockTransactions(async t => {
            t.fail("begin");
            await expect(runInTransaction(() => {})).rejects.toThrow();
            await expect(runInTransaction(() => 42)).resolves.toBe(42);
        });
    });
});

describe("withTestTransaction", () => {
    let manager: FakeTransactionManager;
    beforeEach(() => {
        manager = new FakeTransactionManager();
        useTransactionManager(manager);
    });
    afterEach(() => {
        clearTransactionManager();
        jest.restoreAllMocks();
    });

    it("keeps the physical test transaction hidden and preserves logical commits and results", async () => {
        const physicalCommit = jest.spyOn(manager as any, "commitTransaction");
        const physicalRollback = jest.spyOn(manager as any, "rollbackTransaction");
        const physicalRelease = jest.spyOn(manager as any, "releaseTransaction");
        let info!: TestTransactionInfo;
        const committed = jest.fn();
        const rolledBack = jest.fn();
        expect(await withTestTransaction(async t => {
            const work = t.track(jest.fn(() => 42));
            expect(manager.getCurrentTransaction()).toBeUndefined();
            work();
            expect(t.txOf(work)).toBeUndefined();
            expect(t.transactions).toHaveLength(0);
            return runInTransaction(() => {
                afterCommit(committed);
                afterRollback(rolledBack);
                const result = work();
                info = t.txOf(work, 1)!;
                expect(info.outcome).toBe("active");
                return result;
            });
        })).toBe(42);
        expect(info.outcome).toBe("committed");
        expect(committed).toHaveBeenCalledTimes(1);
        expect(rolledBack).not.toHaveBeenCalled();
        expect(physicalCommit).not.toHaveBeenCalled();
        expect(physicalRollback).toHaveBeenCalledTimes(1);
        expect(physicalRelease).toHaveBeenCalledTimes(1);
        expect(await withTestTransaction(async () => "async")).toBe("async");
        expect(physicalRollback).toHaveBeenCalledTimes(2);
        expect(physicalRelease).toHaveBeenCalledTimes(2);
        expect(manager.getCurrentTransaction()).toBeUndefined();
        expect(getTransactionManager()).toBe(manager);
    });

    it.each([new Error("application"), undefined, null, "plain value"])("preserves thrown value %p", async error => {
        const physicalRollback = jest.spyOn(manager as any, "rollbackTransaction");
        const physicalRelease = jest.spyOn(manager as any, "releaseTransaction");
        let info!: TestTransactionInfo;
        await expect(withTestTransaction(t => {
            const work = t.track(jest.fn());
            return runInTransaction(() => {
                work();
                info = t.txOf(work)!;
                throw error;
            });
        })).rejects.toBe(error);
        expect(info.outcome).toBe("rolled-back");
        expect(physicalRollback).toHaveBeenCalledTimes(1);
        expect(physicalRelease).toHaveBeenCalledTimes(1);
        expect(manager.getCurrentTransaction()).toBeUndefined();
    });

    it("keeps the test session usable after an application transaction rolls back", async () => {
        await expect(withTestTransaction(async t => {
            const work = t.track(jest.fn());
            await runInTransaction(() => { work(); throw new Error("application"); }).catch(() => {});
            await runInTransaction(work);
            expect(t.txOf(work)!.outcome).toBe("rolled-back");
            expect(t.txOf(work, 1)!.outcome).toBe("committed");
            return 123;
        })).resolves.toBe(123);
    });

    it.each([new Error("application"), undefined])(
        "retains callback error %p when physical cleanup rollback fails", async applicationError => {
            const rollbackError = new Error("physical rollback failed");
            const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
            manager.setLogger(log);
            const rollback = jest.spyOn(manager as any, "rollbackTransaction").mockRejectedValue(rollbackError);
            const release = jest.spyOn(manager as any, "releaseTransaction");
            const result = withTestTransaction(() => { throw applicationError; });
            await expect(result).rejects.toBeInstanceOf(TransactionSystemError);
            await expect(result).rejects.toMatchObject({ cause: rollbackError, applicationError });
            expect(log.error).toHaveBeenCalledWith(
                "Transaction application error before rollback failure", applicationError,
            );
            expect(rollback).toHaveBeenCalledTimes(1);
            expect(release).toHaveBeenCalledWith(expect.any(Object), true);
            expect(manager.getCurrentTransaction()).toBeUndefined();
            expect(getTransactionManager()).toBe(manager);
        },
    );

    it("throws and logs the original physical rollback error after a successful callback", async () => {
        const rollbackError = new Error("physical rollback failed");
        const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
        manager.setLogger(log);
        const rollback = jest.spyOn(manager as any, "rollbackTransaction").mockRejectedValue(rollbackError);
        const release = jest.spyOn(manager as any, "releaseTransaction");
        await expect(withTestTransaction(() => 42)).rejects.toBe(rollbackError);
        expect(log.error).toHaveBeenCalledWith("Transaction rollback failed", rollbackError);
        expect(rollback).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledWith(expect.any(Object), true);
        expect(manager.getCurrentTransaction()).toBeUndefined();
    });

    it("preserves a NESTED constraint failure and its failed recovery, then rejects reuse", async () => {
        const constraintError = new Error("deferred constraint failed");
        const recoveryError = new Error("nested recovery failed");
        class BrokenNestedManager extends FakeTransactionManager {
            protected async checkTestTransactionConstraints(): Promise<void> { throw constraintError; }
            protected async rollbackToSavepoint(_tx?: any, name?: string): Promise<void> {
                if (name === "tranjs_sp_2") throw recoveryError;
                await super.rollbackToSavepoint();
            }
        }
        const poisoned = new BrokenNestedManager();
        poisoned.setLogger({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });
        useTransactionManager(poisoned);
        const release = jest.spyOn(poisoned as any, "releaseTransaction");
        const callback = jest.fn();
        await expect(withTestTransaction(async () => {
            await expect(runInTransaction(async () => {
                const nested = runInTransaction(() => {}, { propagation: Propagation.NESTED });
                await expect(nested).rejects.toBeInstanceOf(TransactionSystemError);
                await expect(nested).rejects.toMatchObject({ cause: recoveryError, applicationError: constraintError });
                await expect(runInTransaction(callback)).rejects.toThrow("closed or broken");
                await expect(runInTransaction(callback, { propagation: Propagation.REQUIRES_NEW }))
                    .rejects.toThrow("closed or broken");
                expect(callback).not.toHaveBeenCalled();
            })).rejects.toThrow("rollback-only");
        })).rejects.toMatchObject({ cause: recoveryError, applicationError: constraintError });
        expect(release).toHaveBeenCalledWith(expect.any(Object), true);
    });

    it("rejects nested test helpers without corrupting the active test session", async () => {
        await withTestTransaction(async outer => {
            const mark = outer.track(jest.fn());
            const inner = jest.fn();
            await runInTransaction(async () => {
                mark();
                const owner = outer.txOf(mark)!;
                const surrounding = manager.getCurrentTransaction();
                await expect(withTestTransaction(inner)).rejects.toThrow();
                expect(inner).not.toHaveBeenCalled();
                expect(manager.getCurrentTransaction()).toBe(surrounding);
                mark();
                expect(outer.txOf(mark, 1)).toBe(owner);
            });
            expect(outer.txOf(mark)!.outcome).toBe("committed");
        });
        expect(manager.getCurrentTransaction()).toBeUndefined();
    });

    it("rejects nested test helpers even when they select another datasource", async () => {
        const datasource = Symbol("nested integration");
        const named = new FakeTransactionManager();
        useTransactionManager(named, datasource);
        const begin = jest.spyOn(named as any, "beginTransaction");
        const inner = jest.fn();
        try {
            await withTestTransaction(async t => {
                await expect(withTestTransaction(inner, { datasource })).rejects.toThrow("Nested");
                expect(inner).not.toHaveBeenCalled();
                expect(begin).not.toHaveBeenCalled();
                const work = t.track(jest.fn());
                await runInTransaction(work);
                expect(t.txOf(work)!.outcome).toBe("committed");
            });
            expect(getTransactionManager(datasource)).toBe(named);
        } finally { clearTransactionManager(datasource); }
    });

    it("isolates concurrent test scopes on the same real registration", async () => {
        const infos = await Promise.all(Array.from({ length: 12 }, (_, index) => withTestTransaction(async t => {
            const work = t.track(jest.fn());
            return runInTransaction(async () => {
                work();
                const info = t.txOf(work)!;
                const physical = manager.getCurrentTransaction();
                await Promise.resolve();
                await new Promise(resolve => setTimeout(resolve, index % 3));
                expect(manager.getCurrentTransaction()).toBe(physical);
                work();
                expect(t.txOf(work, 1)).toBe(info);
                expect(info.outcome).toBe("active");
                return info;
            });
        })));
        expect(new Set(infos).size).toBe(12);
        expect(infos.every(info => info.outcome === "committed")).toBe(true);
        expect(getTransactionManager()).toBe(manager);
        expect(manager.getCurrentTransaction()).toBeUndefined();
    });

    it("selects a datasource without replacing either manager", async () => {
        const datasource = Symbol("integration");
        const named = new FakeTransactionManager();
        useTransactionManager(named, datasource);
        try {
            await withTestTransaction(t => {
                const work = t.track(jest.fn());
                expect(t.datasource).toBe(datasource);
                return runInTransaction(() => {
                    work();
                    expect(t.txOf(work)!.outcome).toBe("active");
                    expect(named.getCurrentTransaction()).toBeDefined();
                    expect(manager.getCurrentTransaction()).toBeUndefined();
                }, { datasource });
            }, { datasource });
            expect(named.getCurrentTransaction()).toBeUndefined();
            expect(getTransactionManager(datasource)).toBe(named);
        } finally { clearTransactionManager(datasource); }
    });

    it("tracks logical REQUIRES_NEW commits and NOT_SUPPORTED calls independently", async () => {
        let probe!: TestTransactionProbe;
        await withTestTransaction(async t => {
            probe = t;
            const mark = t.track(jest.fn());
            await runInTransaction(async () => {
                mark();
                const owner = t.txOf(mark)!;
                await runInTransaction(() => {
                    mark();
                    expect(t.txOf(mark, 1)).not.toBe(owner);
                    expect(t.txOf(mark, 1)!.parent).toBe(owner);
                }, { propagation: Propagation.REQUIRES_NEW });
                await runInTransaction(() => {
                    mark();
                    expect(t.txOf(mark, 2)).toBeUndefined();
                }, { propagation: Propagation.NOT_SUPPORTED });
                expect(t.txOf(mark, 1)!.outcome).toBe("committed");
                expect(owner.outcome).toBe("active");
            });
        });
        expect(probe.transactions.map(info => info.outcome)).toEqual(["committed", "committed"]);
    });

    it("rejects overlapping logical scopes without corrupting the successful branch", async () => {
        await withTestTransaction(async t => {
            const entered = deferred();
            const release = deferred();
            const work = t.track(jest.fn());
            const first = runInTransaction(async () => {
                work();
                entered.resolve();
                await release.promise;
            });
            await entered.promise;
            try { await expect(runInTransaction(work)).rejects.toThrow(); }
            finally { release.resolve(); }
            await first;
            await runInTransaction(work);
            expect(work).toHaveBeenCalledTimes(2);
            expect(t.transactions.every(info => info.outcome === "committed")).toBe(true);
        });
    });

    it("surfaces selected logical rollback errors with their application error", async () => {
        const error = new Error("rollback failed");
        const applicationError = new Error("application");
        manager.setLogger({ info() {}, warn() {}, error() {}, debug() {} });
        await expect(withTestTransaction(t => {
            const work = t.track(jest.fn());
            t.fail("rollback", { containing: work, error });
            return runInTransaction(() => { work(); throw applicationError; });
        })).rejects.toMatchObject({ cause: error, applicationError });
        expect(manager.getCurrentTransaction()).toBeUndefined();
    });

    it("wraps aborted savepoint commits with the fallback 25P02 error and recovers for the next owner", async () => {
        const cause = Object.assign(new Error("transaction aborted"), { code: "25P02" });
        class AbortedManager extends FakeTransactionManager {
            private abortNextRelease = true;
            recovered = 0;
            physicalRollbacks = 0;
            protected async releaseSavepoint(): Promise<void> {
                if (this.abortNextRelease) {
                    this.abortNextRelease = false;
                    throw cause;
                }
            }
            protected async rollbackToSavepoint(): Promise<void> { this.recovered++; }
            protected async rollbackTransaction(): Promise<void> { this.physicalRollbacks++; }
        }
        const aborted = new AbortedManager();
        useTransactionManager(aborted);
        const committed = jest.fn();
        const rolledBack = jest.fn();
        let probe!: TestTransactionProbe;
        await withTestTransaction(async t => {
            probe = t;
            const work = t.track(jest.fn());
            await expect(runInTransaction(() => {
                work();
                afterCommit(committed);
                afterRollback(rolledBack);
            })).rejects.toMatchObject({ name: "TestTransactionAbortedError", code: "25P02", cause });
            expect(t.txOf(work)!.outcome).toBe("rolled-back");
            expect(committed).not.toHaveBeenCalled();
            expect(rolledBack).toHaveBeenCalledTimes(1);
            expect(aborted.getCurrentTransaction()).toBeUndefined();
            await runInTransaction(work);
            expect(t.txOf(work, 1)!.outcome).toBe("committed");
        });
        expect(aborted.recovered).toBe(1);
        expect(aborted.physicalRollbacks).toBe(1);
        expect(probe.transactions.map(info => info.outcome)).toEqual(["rolled-back", "committed"]);
    });

    it("evaluates rollback injection after a native commit failure while still recovering the savepoint", async () => {
        const commitError = new Error("native release failed");
        const injectedError = new Error("selected rollback failed");
        manager.setLogger({ info() {}, warn() {}, error() {}, debug() {} });
        const release = jest.spyOn(manager as any, "releaseSavepoint").mockRejectedValueOnce(commitError);
        const rollback = jest.spyOn(manager as any, "rollbackToSavepoint");
        const hook = jest.fn();
        await withTestTransaction(async t => {
            const work = t.track(jest.fn());
            t.fail("rollback", { containing: work, error: injectedError });
            const result = runInTransaction(() => { work(); afterRollback(hook); });
            await expect(result).rejects.toMatchObject({ cause: injectedError, applicationError: commitError });
            expect(rollback).toHaveBeenCalledTimes(1);
            expect(release).toHaveBeenCalledTimes(2);
            expect(hook).toHaveBeenCalledTimes(1);
            expect(t.txOf(work)!.outcome).toBe("rolled-back");
            await runInTransaction(work);
        });
    });

    it("preserves native recovery failure over injection and blocks a broken session", async () => {
        const commitError = new Error("commit failed");
        const nativeError = new Error("native rollback failed");
        manager.setLogger({ info() {}, warn() {}, error() {}, debug() {} });
        jest.spyOn(manager as any, "rollbackToSavepoint").mockRejectedValueOnce(nativeError);
        await expect(withTestTransaction(async t => {
            const work = t.track(jest.fn());
            t.fail("commit", { containing: work, error: commitError });
            t.fail("rollback", { containing: work, error: new Error("injected") });
            await expect(runInTransaction(work)).rejects.toMatchObject({ cause: nativeError, applicationError: commitError });
            await expect(runInTransaction(work)).rejects.toThrow("closed or broken");
            expect(work).toHaveBeenCalledTimes(1);
        })).rejects.toMatchObject({ cause: nativeError, applicationError: commitError });
    });

    it.each([new Error("recovery failed"), undefined])("poisons the test session after savepoint recovery throws %p", async recoveryError => {
        const applicationError = new Error("application");
        class PoisonedManager extends FakeTransactionManager {
            physicalRollbacks = 0;
            releases: boolean[] = [];
            protected async rollbackToSavepoint(): Promise<void> { throw recoveryError; }
            protected async rollbackTransaction(): Promise<void> { this.physicalRollbacks++; }
            protected async releaseTransaction(_tx: object, failed: boolean): Promise<void> { this.releases.push(failed); }
        }
        const poisoned = new PoisonedManager();
        poisoned.setLogger({ info() {}, warn() {}, error() {}, debug() {} });
        useTransactionManager(poisoned);
        await expect(withTestTransaction(async t => {
            const work = t.track(jest.fn());
            const result = runInTransaction(() => { work(); throw applicationError; });
            await expect(result).rejects.toBeInstanceOf(TransactionSystemError);
            await expect(result).rejects.toMatchObject({ cause: recoveryError, applicationError });
            expect(t.txOf(work)!.outcome).toBe("rolled-back");
            expect(poisoned.getCurrentTransaction()).toBeUndefined();
            await expect(runInTransaction(work)).rejects.toThrow("closed or broken");
            expect(work).toHaveBeenCalledTimes(1);
            expect(t.transactions).toHaveLength(1);
        })).rejects.toMatchObject({ cause: recoveryError, applicationError });
        expect(poisoned.physicalRollbacks).toBe(1);
        expect(poisoned.releases).toEqual([true]);
        expect(poisoned.getCurrentTransaction()).toBeUndefined();
        expect(getTransactionManager()).toBe(poisoned);
    });

    it.each([
        [new Error("release failed"), new Error("recovery failed")],
        [undefined, new Error("recovery failed")],
        [new Error("release failed"), undefined],
        [undefined, undefined],
    ])("retains release error %p when savepoint recovery throws %p", async (applicationError, recoveryError) => {
        class PoisonedReleaseManager extends FakeTransactionManager {
            protected async releaseSavepoint(): Promise<void> { throw applicationError; }
            protected async rollbackToSavepoint(): Promise<void> { throw recoveryError; }
        }
        const poisoned = new PoisonedReleaseManager();
        const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
        poisoned.setLogger(log);
        useTransactionManager(poisoned);
        const rollback = jest.spyOn(poisoned as any, "rollbackTransaction");
        const release = jest.spyOn(poisoned as any, "releaseTransaction");
        const rolledBack = jest.fn();
        const committed = jest.fn();
        await expect(withTestTransaction(async t => {
            const work = t.track(jest.fn());
            const result = runInTransaction(() => {
                work();
                afterRollback(rolledBack);
                afterCommit(committed);
            });
            await expect(result).rejects.toBeInstanceOf(TransactionSystemError);
            await expect(result).rejects.toMatchObject({ cause: recoveryError, applicationError });
            expect(log.error).toHaveBeenCalledWith(
                "Transaction application error before rollback failure", applicationError,
            );
            expect(t.txOf(work)!.outcome).toBe("rolled-back");
            expect(rolledBack).toHaveBeenCalledTimes(1);
            expect(committed).not.toHaveBeenCalled();
            await expect(runInTransaction(work)).rejects.toThrow("closed or broken");
            expect(work).toHaveBeenCalledTimes(1);
        })).rejects.toMatchObject({ cause: recoveryError, applicationError });
        expect(rollback).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledWith(expect.any(Object), true);
        expect(poisoned.getCurrentTransaction()).toBeUndefined();
    });

    it.each([
        [new Error("application"), new Error("recovery")],
        [undefined, new Error("recovery")],
        [new Error("application"), undefined],
        [undefined, undefined],
    ])("runs callback finally and reports caught application %p plus recovery %p", async (applicationError, recoveryError) => {
        manager.setLogger({ info() {}, warn() {}, error() {}, debug() {} });
        jest.spyOn(manager as any, "rollbackToSavepoint").mockRejectedValueOnce(recoveryError);
        const rollback = jest.spyOn(manager as any, "rollbackTransaction");
        const release = jest.spyOn(manager as any, "releaseTransaction");
        const finalized = jest.fn();
        let ownerFailure: unknown;
        const result = withTestTransaction(async () => {
            try {
                await runInTransaction(() => { throw applicationError; }).catch(error => { ownerFailure = error; });
            } finally {
                // The user's finally executes before physical cleanup, even though reuse is blocked.
                expect(rollback).not.toHaveBeenCalled();
                expect(release).not.toHaveBeenCalled();
                await Promise.resolve();
                finalized();
            }
        });
        await expect(result).rejects.toBeInstanceOf(TransactionSystemError);
        await expect(result).rejects.toBe(ownerFailure);
        await expect(result).rejects.toMatchObject({ cause: recoveryError, applicationError });
        expect(finalized).toHaveBeenCalledTimes(1);
        expect(rollback).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledWith(expect.any(Object), true);
    });

    it.each([
        [new Error("application"), new Error("recovery"), new Error("physical rollback"), new Error("physical release")],
        [undefined, undefined, undefined, undefined],
    ])("retains caught owner failures %p/%p through native cleanup failures %p/%p", async (
        applicationError, recoveryError, rollbackError, releaseError,
    ) => {
        manager.setLogger({ info() {}, warn() {}, error() {}, debug() {} });
        jest.spyOn(manager as any, "rollbackToSavepoint").mockRejectedValueOnce(recoveryError);
        const rollback = jest.spyOn(manager as any, "rollbackTransaction").mockRejectedValueOnce(rollbackError);
        const release = jest.spyOn(manager as any, "releaseTransaction").mockRejectedValueOnce(releaseError);
        const finalized = jest.fn();
        const result = withTestTransaction(async () => {
            try {
                await runInTransaction(() => { throw applicationError; }).catch(() => {});
            } finally { finalized(); }
        });
        await expect(result).rejects.toBeInstanceOf(TransactionSystemError);
        await expect(result).rejects.toMatchObject({
            cause: releaseError,
            applicationError: {
                cause: rollbackError,
                applicationError: { cause: recoveryError, applicationError },
            },
        });
        expect(finalized).toHaveBeenCalledTimes(1);
        expect(rollback).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledWith(expect.any(Object), true);
    });

    it.each([new Error("callback finally"), undefined])("retains a distinct callback finally failure %p alongside the broken owner", async finalError => {
        const applicationError = new Error("application");
        const recoveryError = new Error("recovery");
        manager.setLogger({ info() {}, warn() {}, error() {}, debug() {} });
        jest.spyOn(manager as any, "rollbackToSavepoint").mockRejectedValueOnce(recoveryError);
        const result = withTestTransaction(async () => {
            try {
                await runInTransaction(() => { throw applicationError; });
            } finally { throw finalError; }
        });
        await expect(result).rejects.toMatchObject({
            cause: { cause: recoveryError, applicationError },
            applicationError: finalError,
        });
    });
});

describe("transactional service testing", () => {
    class OrderService {
        constructor(readonly repository: { save: (id: number) => void; decrease: (id: number) => void;
            audit: (id: number) => void; mail: (id: number) => void }) {}

        @Transactional()
        async place(id: number) {
            this.repository.save(id);
            this.repository.decrease(id);
            await this.audit(id);
            await this.mail(id);
            return id;
        }

        @Transactional(Propagation.REQUIRES_NEW)
        async audit(id: number) { this.repository.audit(id); }

        @Transactional(Propagation.NOT_SUPPORTED)
        async mail(id: number) { this.repository.mail(id); }

        @Transactional(Propagation.MANDATORY)
        async mandatory(id: number) { this.repository.save(id); }
    }

    afterEach(() => clearTransactionManager());

    it("places save and decrease in one owner, audit in another and mail outside", async () => {
        await mockTransactions(async t => {
            const repository = t.track({ save: jest.fn(), decrease: jest.fn(), audit: jest.fn(), mail: jest.fn() });
            const service = new OrderService(repository);
            expect(await service.place(7)).toBe(7);
            expect(repository.save).toHaveBeenCalledWith(7);
            expect(repository.decrease).toHaveBeenCalledWith(7);
            expect(repository.audit).toHaveBeenCalledWith(7);
            expect(repository.mail).toHaveBeenCalledWith(7);
            const owner = t.txOf(repository.save)!;
            const audit = t.txOf(repository.audit)!;
            expect(t.txOf(repository.decrease)).toBe(owner);
            expect(audit).not.toBe(owner);
            expect(audit.parent).toBe(owner);
            expect(audit.propagation).toBe(Propagation.REQUIRES_NEW);
            expect(t.txOf(repository.mail)).toBeUndefined();
            expect(owner.outcome).toBe("committed");
            expect(audit.outcome).toBe("committed");
            expect(t.transactions).toHaveLength(2);
        });
    });

    it("fails only the commit containing save, leaving the audit committed", async () => {
        await mockTransactions(async t => {
            const repository = t.track({ save: jest.fn(), decrease: jest.fn(), audit: jest.fn(), mail: jest.fn() });
            const error = new Error("order commit failed");
            t.fail("commit", { containing: repository.save, error });
            await expect(new OrderService(repository).place(7)).rejects.toBe(error);
            expect(t.txOf(repository.audit)!.outcome).toBe("committed");
            expect(t.txOf(repository.save)!.outcome).not.toBe("committed");
            expect(repository.mail).toHaveBeenCalledTimes(1);
        });
    });

    it("does not bypass MANDATORY and joins an existing transaction", async () => {
        await mockTransactions(async t => {
            const repository = t.track({ save: jest.fn(), decrease: jest.fn(), audit: jest.fn(), mail: jest.fn() });
            const service = new OrderService(repository);
            await expect(service.mandatory(1)).rejects.toBeInstanceOf(IllegalTransactionStateException);
            expect(repository.save).not.toHaveBeenCalled();
            expect(t.transactions).toHaveLength(0);
            await runInTransaction(() => service.mandatory(2));
            expect(t.txOf(repository.save)).toBe(t.transactions[0]);
            expect(t.txOf(repository.save)!.outcome).toBe("committed");
        });
    });
});

describe("concurrent transaction stress", () => {
    afterEach(() => jest.restoreAllMocks());

    it("isolates 200 seeded async chains across propagation boundaries", async () => {
        await mockTransactions(async t => {
            const manager = getTransactionManager();
            // Observe the internal no-I/O hooks only in this stress test, not through a public event API.
            const hooks = manager as unknown as {
                beginTransaction(): Promise<{ transaction: object }>;
                commitTransaction(tx: object): Promise<void>;
                rollbackTransaction(tx: object): Promise<void>;
                releaseTransaction(tx: object, failed: boolean): Promise<void>;
                createSavepoint(tx: object, name: string): Promise<void>;
                rollbackToSavepoint(tx: object, name: string): Promise<void>;
                releaseSavepoint(tx: object, name: string): Promise<void>;
            };
            const begin = jest.spyOn(hooks, "beginTransaction");
            const commit = jest.spyOn(hooks, "commitTransaction");
            const rollback = jest.spyOn(hooks, "rollbackTransaction");
            const release = jest.spyOn(hooks, "releaseTransaction");
            const createSavepoint = jest.spyOn(hooks, "createSavepoint");
            const rollbackSavepoint = jest.spyOn(hooks, "rollbackToSavepoint");
            const releaseSavepoint = jest.spyOn(hooks, "releaseSavepoint");
            const owners = new Map<object, number>();
            const owned = (tx: object | undefined, chain: number) => {
                expect(tx).toBeDefined();
                if (owners.has(tx!)) expect(owners.get(tx!)).toBe(chain);
                else owners.set(tx!, chain);
                return tx!;
            };
            await Promise.all(Array.from({ length: 200 }, async (_, chain) => {
                // Independent per-chain PRNGs preserve reproducibility despite scheduling.
                let seed = (0x12345678 + chain) >>> 0;
                const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
                const pause = () => new Promise(resolve => setTimeout(resolve, random() % 3));
                const failure = new Error(`chain-${chain}`);
                const mark = t.track(jest.fn());
                const result = runInTransaction(async () => {
                    const outer = owned(manager.getCurrentTransaction(), chain);
                    mark();
                    const owner = t.txOf(mark)!;
                    await pause();
                    expect(manager.getCurrentTransaction()).toBe(outer);
                    await runInTransaction(async () => {
                        expect(manager.getCurrentTransaction()).toBe(outer);
                        mark();
                        expect(t.txOf(mark, 1)).toBe(owner);
                        await pause();
                        expect(manager.getCurrentTransaction()).toBe(outer);
                    });
                    await runInTransaction(async () => {
                        const inner = owned(manager.getCurrentTransaction(), chain);
                        expect(inner).not.toBe(outer);
                        mark();
                        expect(t.txOf(mark, 2)!.parent).toBe(owner);
                        await pause();
                        expect(manager.getCurrentTransaction()).toBe(inner);
                    }, { propagation: Propagation.REQUIRES_NEW });
                    expect(manager.getCurrentTransaction()).toBe(outer);
                    const nestedFails = random() % 2 === 0;
                    const nested = runInTransaction(async () => {
                        expect(manager.getCurrentTransaction()).toBe(outer);
                        mark();
                        expect(t.txOf(mark, 3)).toBe(owner);
                        await pause();
                        expect(manager.getCurrentTransaction()).toBe(outer);
                        if (nestedFails) throw failure;
                    }, { propagation: Propagation.NESTED });
                    if (nestedFails) await expect(nested).rejects.toBe(failure);
                    else await nested;
                    await runInTransaction(async () => {
                        expect(manager.getCurrentTransaction()).toBeUndefined();
                        mark();
                        expect(t.txOf(mark, 4)).toBeUndefined();
                        await pause();
                        expect(manager.getCurrentTransaction()).toBeUndefined();
                        await runInTransaction(async () => {
                            const independent = owned(manager.getCurrentTransaction(), chain);
                            expect(independent).not.toBe(outer);
                            mark();
                            expect(t.txOf(mark, 5)!.parent).toBeUndefined();
                            await pause();
                            expect(manager.getCurrentTransaction()).toBe(independent);
                        });
                        expect(manager.getCurrentTransaction()).toBeUndefined();
                    }, { propagation: Propagation.NOT_SUPPORTED });
                    expect(manager.getCurrentTransaction()).toBe(outer);
                    if (chain % 7 === 0) throw failure;
                });
                if (chain % 7 === 0) await expect(result).rejects.toBe(failure);
                else await result;
                expect(manager.getCurrentTransaction()).toBeUndefined();
                expect(t.txOf(mark)!.outcome).toBe(chain % 7 === 0 ? "rolled-back" : "committed");
            }));
            expect(t.transactions).toHaveLength(600);
            expect(owners.size).toBe(600);
            expect(new Set(t.transactions.map(info => info.id)).size).toBe(600);
            expect(t.transactions.filter(info => info.outcome === "rolled-back")).toHaveLength(29);
            expect(t.transactions.every(info => info.outcome !== "active")).toBe(true);
            expect(begin).toHaveBeenCalledTimes(600);
            expect(commit).toHaveBeenCalledTimes(571);
            expect(rollback).toHaveBeenCalledTimes(29);
            expect(release).toHaveBeenCalledTimes(600);
            expect(createSavepoint).toHaveBeenCalledTimes(200);
            for (const tx of owners.keys()) {
                const commits = commit.mock.calls.filter(call => call[0] === tx);
                const rollbacks = rollback.mock.calls.filter(call => call[0] === tx);
                expect(commits.length + rollbacks.length).toBe(1);
                expect(release.mock.calls.filter(call => call[0] === tx)).toEqual([[tx, false]]);
                const created = createSavepoint.mock.calls.filter(call => call[0] === tx).map(call => call[1]);
                const completed = [...rollbackSavepoint.mock.calls, ...releaseSavepoint.mock.calls]
                    .filter(call => call[0] === tx).map(call => call[1]);
                expect(completed).toEqual(created);
            }
            expect(manager.getCurrentTransaction()).toBeUndefined();
        });
        expect(() => getTransactionManager()).toThrow(DatasourceSetupError);
    });
});
