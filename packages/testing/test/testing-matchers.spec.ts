import { AssertionError } from "node:assert";
import {
    afterCommit, afterRollback, clearTransactionManager, getTransactionManager, Propagation,
    runInTransaction, TransactionSystemError, useTransactionManager,
} from "@tranjs/core";
import {
    assertAfterCommitOf, assertCommitted, assertOutsideTransaction, assertRolledBack,
    assertSameTransaction, assertSeparateTransaction, matchers, mockTransactions,
    transactions, withTestTransaction,
} from "../src";
import { FakeTransactionManager } from "../src/fake";

expect.extend(matchers);
const check = expect as any;

afterEach(() => {
    clearTransactionManager();
    jest.restoreAllMocks();
});

describe("framework-neutral transaction assertions", () => {
    it.each([false, true])("resolves the same original in concurrent portable scopes (frozen: %s)", async frozen => {
        useTransactionManager(new FakeTransactionManager());
        const original = { save() {} };
        if (frozen) {
            Object.freeze(original.save);
            Object.freeze(original);
        }
        let ready = 0;
        let release!: () => void;
        const bothReady = new Promise<void>(resolve => { release = resolve; });
        const wrappers = await Promise.all([0, 1].map(index => withTestTransaction(async t => {
            const repository = t.track(original);
            const peer = t.track(function peer() {});
            const work = runInTransaction(() => {
                repository.save();
                peer();
                if (index) throw new Error("rollback second scope");
            });
            if (index) await expect(work).rejects.toThrow("rollback second scope");
            else await work;
            if (++ready === 2) release();
            await bothReady;
            await Promise.resolve();
            assertSameTransaction(original.save, peer);
            expect(t.txOf(original.save)).toBe(t.txOf(repository.save));
            if (index) {
                assertRolledBack(original.save);
                check(original.save).not.toHaveCommitted();
            } else {
                assertCommitted(original.save);
                check(original.save).not.toHaveRolledBack();
            }
            return repository.save;
        })));
        assertCommitted(wrappers[0]);
        assertRolledBack(wrappers[1]);
        expect(() => assertCommitted(original.save)).toThrow(new TypeError(
            "toHaveCommitted: received: Original function belongs to multiple transaction probes; use its tracked wrapper outside an active session",
        ));
        expect(() => check(original.save).not.toHaveCommitted()).toThrow(TypeError);
    });

    it("does not borrow another session's original evidence after the owning session closes", async () => {
        useTransactionManager(new FakeTransactionManager());
        function original() {}
        let secondReady!: () => void;
        const started = new Promise<void>(resolve => { secondReady = resolve; });
        let releaseDangling!: () => void;
        const danglingGate = new Promise<void>(resolve => { releaseDangling = resolve; });
        let releaseSecond!: () => void;
        const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
        let dangling!: Promise<void>;
        const first = withTestTransaction(async t => {
            const work = t.track(original);
            await runInTransaction(work);
            await started;
            dangling = danglingGate.then(() => {
                expect(() => assertRolledBack(original)).toThrow("Original function belongs to multiple transaction probes");
                assertCommitted(work);
            });
        });
        const second = withTestTransaction(async t => {
            const work = t.track(original);
            await expect(runInTransaction(() => { work(); throw new Error("second"); })).rejects.toThrow("second");
            secondReady();
            await secondGate;
            assertRolledBack(original);
        });
        try {
            await first;
            expect(() => assertRolledBack(original)).toThrow("Original function belongs to multiple transaction probes");
            releaseDangling();
            await dangling;
        } finally { releaseSecond(); }
        await second;
    });

    it("rejects an original untracked in the current session rather than selecting another probe", async () => {
        function original() {}
        await mockTransactions(async first => {
            const wrapper = first.track(original);
            wrapper();
            await mockTransactions(() => {
                expect(() => assertOutsideTransaction(original)).toThrow("Original function was not tracked by the current transaction probe");
                assertOutsideTransaction(wrapper);
            }, { datasource: Symbol("other") });
            assertOutsideTransaction(original);
        });
    });

    it("rejects tracking another session's wrapper without changing its immutable evidence", async () => {
        let wrapper!: () => void;
        await mockTransactions(t => { wrapper = t.track(function original() {}); wrapper(); });
        await mockTransactions(t => {
            expect(() => t.track(wrapper)).toThrow("Cannot track a wrapper belonging to a different transaction probe");
            assertOutsideTransaction(wrapper);
        });
        assertOutsideTransaction(wrapper);
    });

    it("exports six base matchers, accepts original methods, and asserts joined/NESTED owner identity", async () => {
        expect(Object.keys(matchers)).toEqual([
            "toRunInSameTransactionAs", "toRunInSeparateTransactionFrom", "toRunOutsideTransaction",
            "toRunAfterCommitOf", "toHaveCommitted", "toHaveRolledBack",
        ]);
        await mockTransactions(async t => {
            const original = { save() {}, decrease() {}, nested() {} };
            const repository = t.track(original);
            await runInTransaction(async () => {
                repository.save();
                await runInTransaction(repository.decrease);
                await runInTransaction(repository.nested, { propagation: Propagation.NESTED });
                expect(() => assertCommitted(repository.save)).toThrow(AssertionError);
            });
            assertSameTransaction(repository.save, repository.decrease);
            assertSameTransaction(original.save, repository.nested);
            assertCommitted(repository.save);
            check(repository.save).toRunInSameTransactionAs(repository.nested);
            check(repository.save).not.toRunInSeparateTransactionFrom(repository.decrease);
            check(repository.save).not.toRunOutsideTransaction();
            check(repository.save).toHaveCommitted();
            check(repository.save).not.toHaveRolledBack();
        });
    });

    it("asserts separate REQUIRES_NEW and consecutive transactions but never equates two outside calls", async () => {
        await mockTransactions(async t => {
            const outer = t.track(function save() {});
            const inner = t.track(function audit() {});
            const later = t.track(function later() {});
            const outside = t.track(function mail() {});
            const otherOutside = t.track(function otherMail() {});
            await runInTransaction(async () => {
                outer();
                await runInTransaction(inner, { propagation: Propagation.REQUIRES_NEW });
                await runInTransaction(outside, { propagation: Propagation.NOT_SUPPORTED });
            });
            await runInTransaction(later);
            otherOutside();
            assertSeparateTransaction(inner, outer);
            assertSeparateTransaction(outer, later);
            assertOutsideTransaction(outside);
            check(inner).toRunInSeparateTransactionFrom(outer);
            check(outside).toRunOutsideTransaction();
            check(outside).not.toRunInSameTransactionAs(otherOutside);
            check(outside).not.toRunInSeparateTransactionFrom(otherOutside);
            check(outside).not.toRunInSeparateTransactionFrom(outer);
            check(outside).not.toHaveCommitted();
            check(outside).not.toHaveRolledBack();
        });
    });

    it("reports rollback and injected commit failure without considering either committed", async () => {
        await mockTransactions(async t => {
            const failed = t.track(function save() {});
            const commitFailed = t.track(function update() {});
            await expect(runInTransaction(() => { failed(); throw new Error("application"); })).rejects.toThrow("application");
            t.fail("commit", { containing: commitFailed });
            await expect(runInTransaction(commitFailed)).rejects.toThrow("commit failed");
            assertRolledBack(failed);
            assertRolledBack(commitFailed);
            check(failed).toHaveRolledBack();
            check(commitFailed).not.toHaveCommitted();
            expect(() => assertCommitted(failed)).toThrow(AssertionError);
        });
    });

    it("requires genuine asynchronous afterCommit provenance, not merely a later outside call", async () => {
        await mockTransactions(async t => {
            const save = t.track(function save() {});
            const mail = t.track(function mail() {});
            const ordinary = t.track(function ordinary() {});
            const immediateHook = t.track(function immediateHook() {});
            await runInTransaction(() => {
                save();
                afterCommit(async () => { await Promise.resolve(); mail(); });
            });
            ordinary();
            await afterCommit(immediateHook);
            assertAfterCommitOf(mail, save);
            check(mail).toRunAfterCommitOf(save);
            check(ordinary).not.toRunAfterCommitOf(save);
            check(immediateHook).not.toRunAfterCommitOf(save);
            assertOutsideTransaction(mail);
            expect(() => assertAfterCommitOf(ordinary, save)).toThrow(AssertionError);
        });
    });

    it("does not confuse an inner owner's callback with the outer owner or callbacks that start transactions", async () => {
        await mockTransactions(async t => {
            const outer = t.track(function outer() {});
            const inner = t.track(function inner() {});
            const mail = t.track(function mail() {});
            const transactionalMail = t.track(function transactionalMail() {});
            await runInTransaction(async () => {
                outer();
                await runInTransaction(() => {
                    inner();
                    afterCommit(mail);
                }, { propagation: Propagation.REQUIRES_NEW });
                afterCommit(() => runInTransaction(transactionalMail));
            });
            assertAfterCommitOf(mail, inner);
            check(mail).not.toRunAfterCommitOf(outer);
            check(transactionalMail).not.toRunAfterCommitOf(outer);
            assertCommitted(transactionalMail);
        });
    });

    it("does not attribute rollback synchronizations to afterCommit", async () => {
        await mockTransactions(async t => {
            const save = t.track(function save() {});
            const mail = t.track(function mail() {});
            await expect(runInTransaction(() => {
                save();
                afterRollback(mail);
                throw new Error("rollback");
            })).rejects.toThrow("rollback");
            assertOutsideTransaction(mail);
            check(mail).not.toRunAfterCommitOf(save);
        });
    });

    it("uses the same provenance and assertions in the integration helper", async () => {
        useTransactionManager(new FakeTransactionManager());
        await withTestTransaction(async t => {
            const save = t.track(function save() {});
            const mail = t.track(function mail() {});
            await runInTransaction(() => { save(); afterCommit(mail); });
            assertCommitted(save);
            assertAfterCommitOf(mail, save);
        });
    });

    it("preserves immutable recorded evidence after the test session closes", async () => {
        let save!: () => void;
        await mockTransactions(async t => {
            save = t.track(function save() {});
            await runInTransaction(save);
        });
        assertCommitted(save);
        check(save).toHaveCommitted();
    });
});

describe("matcher usage errors and exact diagnostics", () => {
    it("prefers explicit mock names, then object properties, then standalone function names", async () => {
        await mockTransactions(t => {
            const vitestDefault = jest.fn();
            vitestDefault.getMockName = () => "vi.fn()";
            const constructorDefault = jest.fn();
            constructorDefault.getMockName = () => "mockConstructor";
            const vitest3Default = jest.fn();
            vitest3Default.getMockName = () => "spy";
            const original = {
                debit: jest.fn().mockName("accounts.debit"), credit: jest.fn(),
                vitestDefault, constructorDefault, vitest3Default,
                propertyLabel: function implementationName() {},
            };
            const accounts = t.track(original);
            for (const fn of Object.values(accounts)) fn();
            for (const [key, expected] of [
                ["debit", "accounts.debit"], ["credit", "credit"],
                ["vitestDefault", "vitestDefault"], ["constructorDefault", "constructorDefault"],
                ["vitest3Default", "vitest3Default"],
                ["propertyLabel", "propertyLabel"],
            ] as const) {
                expect(matchers.toHaveCommitted.call({}, accounts[key]).message()).toBe(
                    `Expected tracked function toHaveCommitted()\nReceived: ${expected} → outside transaction, event ${Object.keys(original).indexOf(key) + 1}`,
                );
            }
            accounts.credit.mockName("accounts.credit");
            expect(matchers.toHaveCommitted.call({}, accounts.credit).message()).toContain("Received: accounts.credit →");
            const standalone = t.track(function standaloneName() {});
            standalone();
            expect(matchers.toHaveCommitted.call({}, standalone).message()).toContain("Received: standaloneName →");
        });
    });

    it.each(Object.keys(matchers) as (keyof typeof matchers)[])("%s throws malformed operands even under .not", async name => {
        await mockTransactions(t => {
            const once = t.track(function once() {});
            const never = t.track(function never() {});
            const twice = t.track(function twice() {});
            once(); twice(); twice();
            const matcher = matchers[name];
            const binary = name.endsWith("As") || name.endsWith("From") || name.endsWith("Of");
            const invoke = (received: unknown, other = once) => matcher.call({ isNot: true }, received, other);
            expect(() => invoke(() => {})).toThrow(new TypeError(`${name}: received must be a function tracked by transactions().track or the test probe's track`));
            expect(() => invoke(null)).toThrow(TypeError);
            expect(() => invoke(never)).toThrow(new TypeError(`${name}: received must have exactly one recorded call; received 0`));
            expect(() => invoke(twice)).toThrow(new TypeError(`${name}: received must have exactly one recorded call; received 2`));
            expect(() => check(never).not[name](once)).toThrow(TypeError);
            expect(() => check(twice).not[name](once)).toThrow(TypeError);
            if (binary) {
                expect(() => invoke(once, never)).toThrow(new TypeError(`${name}: other must have exactly one recorded call; received 0`));
                expect(() => invoke(once, twice)).toThrow(new TypeError(`${name}: other must have exactly one recorded call; received 2`));
                expect(() => matcher.call({ isNot: true }, once)).toThrow(new TypeError(`${name}: other must be a function tracked by transactions().track or the test probe's track`));
            }
        });
    });

    it.each(["toRunInSameTransactionAs", "toRunInSeparateTransactionFrom", "toRunAfterCommitOf"] as const)(
        "%s rejects operands belonging to distinct test sessions, including under .not", async name => {
            let first!: () => void;
            await mockTransactions(t => { first = t.track(function first() {}); first(); });
            await mockTransactions(t => {
                const second = t.track(function second() {});
                second();
                expect(() => matchers[name].call({ isNot: true }, first, second)).toThrow(
                    new TypeError(`${name}: Functions belong to different transaction probes`),
                );
                expect(() => check(first).not[name](second)).toThrow(TypeError);
            });
        },
    );

    it("names the missed transaction, propagation, outcome and call event exactly", async () => {
        await mockTransactions(async t => {
            const save = t.track(function save() {});
            const mail = t.track(function mail() {});
            await runInTransaction(save);
            mail();
            const result = matchers.toRunInSameTransactionAs.call({}, mail, save);
            expect(result.pass).toBe(false);
            expect(result.message()).toBe(
                "Expected tracked function toRunInSameTransactionAs(other)\n" +
                "Received: mail → outside transaction, event 3\n" +
                "Other: save → tx#1 (REQUIRED, committed), event 1",
            );
            expect(() => assertSameTransaction(mail, save)).toThrow(new AssertionError({
                message: result.message(), operator: "toRunInSameTransactionAs", actual: mail, expected: save,
            }));
            expect(matchers.toHaveCommitted.call({ isNot: true }, save).message()).toBe(
                "Expected tracked function not toHaveCommitted()\nReceived: save → tx#1 (REQUIRED, committed), event 1",
            );
            expect(matchers.toRunAfterCommitOf.call({}, mail, save).message()).toBe(
                "Expected tracked function toRunAfterCommitOf(other)\n" +
                "Received: mail → outside transaction, event 3\n" +
                "Other: save → tx#1 (REQUIRED, committed), event 1\n" +
                "Requires an observed afterCommit callback for the committed transaction (later outside calls do not qualify).",
            );
            expect(matchers.toRunOutsideTransaction.call({ isNot: true }, save).message()).toBe(
                "Expected tracked function not toRunOutsideTransaction()\nReceived: save → tx#1 (REQUIRED, committed), event 1",
            );
        });
    });

    it("fails successful positive assertions under .not with their full diagnostic", async () => {
        await mockTransactions(async t => {
            const save = t.track(function save() {});
            const decrease = t.track(function decrease() {});
            const audit = t.track(function audit() {});
            const mail = t.track(function mail() {});
            const rollback = t.track(function rollback() {});
            await runInTransaction(() => { save(); decrease(); afterCommit(mail); });
            await runInTransaction(audit, { propagation: Propagation.REQUIRES_NEW });
            await expect(runInTransaction(() => { rollback(); throw new Error("rollback"); })).rejects.toThrow();
            for (const [name, a, b] of [
                ["toRunInSameTransactionAs", save, decrease],
                ["toRunInSeparateTransactionFrom", save, audit],
                ["toRunOutsideTransaction", mail],
                ["toRunAfterCommitOf", mail, save],
                ["toHaveCommitted", save],
                ["toHaveRolledBack", rollback],
            ] as const) {
                expect(() => check(a).not[name](b)).toThrow(`Expected tracked function not ${name}`);
            }
        });
    });
});

describe("transactions() accessor and portable lifecycle", () => {
    it("rejects every propagation while the helper's native begin is initializing", async () => {
        const manager = new FakeTransactionManager();
        useTransactionManager(manager);
        const callback = jest.fn();
        const begin = jest.spyOn(manager as any, "beginTransaction").mockImplementation(async () => {
            const probe = transactions();
            for (const propagation of Object.values(Propagation)) {
                await expect(runInTransaction(callback, { propagation })).rejects.toThrow("initialization is still in progress");
            }
            expect(probe.transactions).toHaveLength(0);
            expect(callback).not.toHaveBeenCalled();
            return { transaction: {} };
        });
        await withTestTransaction(async t => {
            expect(transactions()).toBe(t);
            await runInTransaction(callback);
        });
        expect(begin).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledTimes(1);
        expect(() => transactions()).toThrow("active transaction test session");
    });

    it("keeps failed initialization's cause in retained native-begin tasks", async () => {
        const manager = new FakeTransactionManager();
        useTransactionManager(manager);
        const cause = new Error("physical initialization failed");
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const callback = jest.fn();
        let detached!: Promise<void>;
        jest.spyOn(manager as any, "beginTransaction").mockImplementation(async () => {
            detached = gate.then(async () => {
                for (const propagation of Object.values(Propagation)) {
                    const result = runInTransaction(callback, { propagation });
                    await expect(result).rejects.toThrow("initialization failed");
                    await expect(result).rejects.toMatchObject({ cause });
                }
                expect(() => transactions()).toThrow("active transaction test session");
            });
            throw cause;
        });
        await expect(withTestTransaction(callback)).rejects.toBe(cause);
        release();
        await detached;
        expect(callback).not.toHaveBeenCalled();
        expect(() => transactions()).toThrow("active transaction test session");
    });

    it("allocates hook provenance storage only when an afterCommit callback runs", async () => {
        let allocations = 0;
        jest.doMock("node:async_hooks", () => {
            const actual = jest.requireActual("node:async_hooks");
            return {
                ...actual,
                AsyncLocalStorage: class extends actual.AsyncLocalStorage {
                    constructor() { super(); allocations++; }
                },
            };
        });
        try {
            await jest.isolateModulesAsync(async () => {
                const core = require("@tranjs/core") as typeof import("@tranjs/core");
                expect(allocations).toBe(1);
                const testing = require("../src") as typeof import("../src");
                expect(allocations).toBe(1);
                await testing.mockTransactions(async t => {
                    const work = t.track(function work() {});
                    await core.runInTransaction(work);
                    testing.assertCommitted(work);
                });
                expect(allocations).toBe(2);
                await testing.mockTransactions(() => {});
                expect(allocations).toBe(2);
                await testing.mockTransactions(async t => {
                    const work = t.track(function work() {});
                    const hook = t.track(function hook() {});
                    await core.runInTransaction(() => { work(); core.afterCommit(hook); });
                    testing.assertAfterCommitOf(hook, work);
                });
                expect(allocations).toBe(3);
                await testing.mockTransactions(() => {});
                expect(allocations).toBe(3);
            });
        } finally { jest.dontMock("node:async_hooks"); }
    });

    it("rejects access outside a session, even without a registered datasource", () => {
        expect(() => transactions()).toThrow("transactions() requires an active transaction test session");
        expect(() => transactions(Symbol("missing"))).toThrow("transactions() requires an active transaction test session");
    });

    it("returns the exact probe across awaits in mock and integration helpers", async () => {
        await mockTransactions(async t => {
            expect(transactions()).toBe(t);
            expect(transactions(t.datasource)).toBe(t);
            await Promise.resolve();
            expect(transactions()).toBe(t);
        });
        useTransactionManager(new FakeTransactionManager());
        await withTestTransaction(async t => {
            expect(transactions()).toBe(t);
            await runInTransaction(async () => {
                await Promise.resolve();
                expect(transactions()).toBe(t);
            });
        });
        expect(() => transactions()).toThrow("active transaction test session");
    });

    it("keeps concurrent integration sessions and named mock sessions separate", async () => {
        useTransactionManager(new FakeTransactionManager());
        const probes = await Promise.all(Array.from({ length: 8 }, async () => withTestTransaction(async t => {
            await Promise.resolve();
            expect(transactions()).toBe(t);
            return t;
        })));
        expect(new Set(probes).size).toBe(8);
        const datasource = Symbol("named");
        await mockTransactions(async outer => {
            await mockTransactions(async inner => {
                expect(transactions()).toBe(inner);
                expect(transactions(outer.datasource)).toBe(outer);
                await Promise.resolve();
                expect(transactions(datasource)).toBe(inner);
            }, { datasource });
            expect(transactions()).toBe(outer);
        });
    });

    it("does not let a dangling async task access a closed session", async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        let dangling!: Promise<void>;
        await mockTransactions(() => {
            dangling = gate.then(() => { expect(() => transactions()).toThrow("active transaction test session"); });
        });
        release();
        await dangling;
    });

    it("does not fall back to an outer probe from a closed inner session's dangling task", async () => {
        await mockTransactions(async outer => {
            let release!: () => void;
            const gate = new Promise<void>(resolve => { release = resolve; });
            let dangling!: Promise<void>;
            await mockTransactions(() => {
                dangling = gate.then(() => { expect(() => transactions()).toThrow("active transaction test session"); });
            }, { datasource: Symbol("inner") });
            expect(transactions()).toBe(outer);
            release();
            await dangling;
        });
    });

    it("binds native begin and the callback to one probe, then cleans up once", async () => {
        const manager = new FakeTransactionManager();
        useTransactionManager(manager);
        const rollback = jest.spyOn(manager as any, "rollbackTransaction");
        const release = jest.spyOn(manager as any, "releaseTransaction");
        let probe!: ReturnType<typeof transactions>;
        const begin = jest.spyOn(manager as any, "beginTransaction").mockImplementation(async () => {
            probe = transactions();
            return { transaction: {} };
        });
        await withTestTransaction(async t => {
            await Promise.resolve();
            expect(t).toBe(probe);
            expect(transactions()).toBe(probe);
            expect(manager.getCurrentTransaction()).toBeUndefined();
        });
        expect(begin).toHaveBeenCalledTimes(1);
        expect(rollback).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledTimes(1);
        expect(() => transactions()).toThrow("active transaction test session");
        begin.mockRestore();
        await withTestTransaction(() => {});
    });

    it("does not clean up an unacquired physical transaction after begin failure", async () => {
        const manager = new FakeTransactionManager();
        useTransactionManager(manager);
        const error = new Error("begin failed");
        jest.spyOn(manager as any, "beginTransaction").mockRejectedValue(error);
        const rollback = jest.spyOn(manager as any, "rollbackTransaction");
        const release = jest.spyOn(manager as any, "releaseTransaction");
        const callback = jest.fn();
        await expect(withTestTransaction(callback)).rejects.toBe(error);
        expect(callback).not.toHaveBeenCalled();
        expect(rollback).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
        expect(() => transactions()).toThrow("active transaction test session");
    });

    it.each([undefined, new Error("application")])("retains application failure %p when physical release fails", async applicationError => {
        const manager = new FakeTransactionManager();
        manager.setLogger({ info() {}, warn() {}, error() {}, debug() {} });
        useTransactionManager(manager);
        const releaseError = new Error("release failed");
        jest.spyOn(manager as any, "releaseTransaction").mockRejectedValue(releaseError);
        const result = withTestTransaction(() => { throw applicationError; });
        await expect(result).rejects.toBeInstanceOf(TransactionSystemError);
        await expect(result).rejects.toMatchObject({ cause: releaseError, applicationError });
    });

    it("retains all three failures when application, rollback and release fail", async () => {
        const manager = new FakeTransactionManager();
        manager.setLogger({ info() {}, warn() {}, error() {}, debug() {} });
        useTransactionManager(manager);
        const applicationError = new Error("application");
        const rollbackError = new Error("rollback");
        const releaseError = new Error("release");
        jest.spyOn(manager as any, "rollbackTransaction").mockRejectedValue(rollbackError);
        jest.spyOn(manager as any, "releaseTransaction").mockRejectedValue(releaseError);
        const result = withTestTransaction(() => { throw applicationError; });
        await expect(result).rejects.toMatchObject({
            cause: releaseError,
            applicationError: { cause: rollbackError, applicationError },
        });
    });

    it("surfaces a release failure unchanged after successful application and rollback", async () => {
        const manager = new FakeTransactionManager();
        manager.setLogger({ info() {}, warn() {}, error() {}, debug() {} });
        useTransactionManager(manager);
        const error = new Error("release");
        jest.spyOn(manager as any, "releaseTransaction").mockRejectedValue(error);
        await expect(withTestTransaction(() => 42)).rejects.toBe(error);
        expect(getTransactionManager()).toBe(manager);
    });
});
