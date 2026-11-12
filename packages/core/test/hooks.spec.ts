import { AsyncResource } from "node:async_hooks";
import {
    afterCommit, afterRollback, AsyncLocal, DatasourceSetupError, DEFAULT_DATASOURCE, MetadataWrappedTransaction,
    PlatformTransactionManager, Propagation, TxState, useTransactionManager,
} from "../src";

interface Tx { id: number }

/** Records every driver call and hook in one shared list, so tests assert a single order. */
class HookManager extends PlatformTransactionManager<Tx> {
    commitError?: Error;
    rollbackError?: Error;
    savepointRollbackError?: Error;
    releaseSavepointError?: Error;
    /** Called once while the next COMMIT, ROLLBACK or savepoint statement is in flight. */
    during?: () => void;
    readonly logged: unknown[][] = [];
    private nextId = 0;

    constructor(private readonly name: string, private readonly events: string[]) {
        super();
        this.setLogger({ info() {}, warn() {}, debug() {}, error: (...args: unknown[]) => { this.logged.push(args); } });
    }

    run<R>(callback: () => R | Promise<R>, propagation = Propagation.REQUIRED): Promise<R> {
        return this.executeTransaction(propagation, callback);
    }

    state(): TxState | null | undefined { return AsyncLocal.Frame?.txs.get(this); }

    private async io(event: string, error?: Error): Promise<void> {
        this.events.push(`${this.name}:${event}`);
        const during = this.during;
        if (during) {
            this.during = undefined;
            await Promise.resolve();
            during();
            await Promise.resolve();
        }
        if (error) throw error;
    }

    protected async beginTransaction(): Promise<MetadataWrappedTransaction<Tx>> {
        this.events.push(`${this.name}:begin`);
        return { transaction: { id: ++this.nextId }, metadata: { driverName: "hooks" } };
    }
    protected commitTransaction(): Promise<void> { return this.io("commit", this.commitError); }
    protected rollbackTransaction(): Promise<void> { return this.io("rollback", this.rollbackError); }
    protected async createSavepoint(): Promise<void> { this.events.push(`${this.name}:savepoint`); }
    protected rollbackToSavepoint(): Promise<void> { return this.io("rollback to", this.savepointRollbackError); }
    protected releaseSavepoint(): Promise<void> { return this.io("release", this.releaseSavepointError); }
}

const named = Symbol("named");
const failure = new Error("application failure");
/** Run later in the async context where this was created, as detached work would. */
type Retained = <T>(fn: () => T) => T;
const retain = (): Retained => AsyncResource.bind(<T>(fn: () => T): T => fn());
const rejected = (operation: Promise<unknown>, error: unknown = failure) => expect(operation).rejects.toBe(error);

describe("afterCommit / afterRollback", () => {
    let events: string[];
    let a: HookManager;
    let b: HookManager;
    const mark = (label: string) => () => { events.push(label); };
    /** Register both hooks. An immediate invocation of a synchronous callback has run when this returns. */
    const both = (label: string, datasource?: string | symbol) => {
        afterCommit(mark(`${label}:commit`), datasource);
        void afterRollback(mark(`${label}:rollback`), datasource);
    };
    const fail = (): never => { throw failure; };

    beforeEach(() => {
        events = [];
        a = new HookManager("a", events);
        b = new HookManager("b", events);
        useTransactionManager(a);
        useTransactionManager(b, named);
    });
    afterEach(() => {
        useTransactionManager(undefined as any);
        useTransactionManager(undefined as any, named);
    });

    describe("the transaction a hook addresses, and what its state means", () => {
        const rows: [name: string, scenario: () => unknown, expected: string[], logged?: unknown[][]][] = [
            ["no transaction: afterCommit invokes now, afterRollback does nothing",
                () => { both("hook"); events.push("after registration"); },
                ["hook:commit", "after registration"]],
            ["active, then committed: queued until the commit",
                () => a.run(() => { both("hook"); events.push("body"); }),
                ["a:begin", "body", "a:commit", "hook:commit"]],
            ["active, then rolled back: queued until the rollback",
                () => rejected(a.run(() => { both("hook"); fail(); })),
                ["a:begin", "a:rollback", "hook:rollback"]],
            ["committed: afterCommit invokes now, afterRollback does nothing",
                async () => {
                    let late!: Retained;
                    await a.run(() => { late = retain(); });
                    late(() => both("late"));
                    events.push("after registration");
                },
                ["a:begin", "a:commit", "late:commit", "after registration"]],
            ["rolled back: afterRollback invokes now, afterCommit does nothing",
                async () => {
                    let late!: Retained;
                    await rejected(a.run(() => { late = retain(); fail(); }));
                    expect(late(() => a.state())).toMatchObject({ active: false, outcome: "rolled-back" });
                    late(() => both("late"));
                    events.push("after registration");
                },
                ["a:begin", "a:rollback", "late:rollback", "after registration"]],
            ["commit failed: outcome unknown, treated as not committed",
                async () => {
                    let late!: Retained;
                    a.commitError = new Error("commit failed");
                    await rejected(a.run(() => { late = retain(); both("queued"); }), a.commitError);
                    expect(late(() => a.state())).toMatchObject({ active: false, outcome: "failed" });
                    late(() => both("late"));
                },
                ["a:begin", "a:commit", "queued:rollback", "late:rollback"]],
            ["rollback failed: outcome unknown, treated as not committed",
                async () => {
                    let late!: Retained;
                    a.rollbackError = new Error("rollback failed");
                    await expect(a.run(() => { late = retain(); both("queued"); fail(); })).rejects.toMatchObject({
                        name: "TransactionSystemError", cause: a.rollbackError, applicationError: failure,
                    });
                    expect(late(() => a.state())).toMatchObject({ active: false, outcome: "failed" });
                    late(() => both("late"));
                },
                ["a:begin", "a:rollback", "queued:rollback", "late:rollback"],
                [["Transaction application error before rollback failure", failure]]],
            ["explicit name: the active outer transaction, from inside another datasource's",
                () => a.run(() => b.run(() => both("explicit", DEFAULT_DATASOURCE))),
                ["a:begin", "b:begin", "b:commit", "a:commit", "explicit:commit"]],
            ["explicit name: a finished transaction is acted on by its outcome while the outer one is active",
                () => a.run(async () => {
                    let late!: Retained;
                    await rejected(b.run(() => { late = retain(); fail(); }));
                    late(() => both("explicit", named));
                    // From the same retained context, the outer name still selects the active outer transaction.
                    late(() => both("outer", DEFAULT_DATASOURCE));
                    events.push("outer continues");
                }),
                ["a:begin", "b:begin", "b:rollback", "explicit:rollback", "outer continues", "a:commit", "outer:commit"]],
            ["explicit name: no transaction of that datasource in this context is 'no transaction'",
                () => a.run(() => { both("explicit", named); events.push("body"); }),
                ["a:begin", "explicit:commit", "body", "a:commit"]],
            ["unregistered name: both hooks throw DatasourceSetupError and invoke nothing",
                () => a.run(() => {
                    expect(() => afterCommit(mark("wrong"), "unregistered")).toThrow(DatasourceSetupError);
                    expect(() => afterRollback(mark("wrong"), "unregistered")).toThrow(DatasourceSetupError);
                }),
                ["a:begin", "a:commit"]],
            ["unregistered name outside a transaction: both hooks throw, too",
                () => {
                    expect(() => afterCommit(mark("wrong"), "unregistered")).toThrow("unregistered");
                    expect(() => afterRollback(mark("wrong"), "unregistered")).toThrow(DatasourceSetupError);
                },
                []],
            ["suspended transaction: NOT_SUPPORTED is 'no transaction', never the suspended owner",
                () => rejected(a.run(async () => {
                    await a.run(() => both("suspended"), Propagation.NOT_SUPPORTED);
                    events.push("body");
                    fail();
                })),
                ["a:begin", "suspended:commit", "body", "a:rollback"]],
            ["joined scope: the owner's queue, still valid after the joined call returned",
                () => a.run(async () => {
                    let joined!: Retained;
                    for (const propagation of [Propagation.REQUIRED, Propagation.MANDATORY, Propagation.SUPPORTS]) {
                        await a.run(() => { both(propagation); joined = retain(); }, propagation);
                    }
                    joined(() => both("after the joined call"));
                    events.push("body");
                }),
                ["a:begin", "body", "a:commit", "REQUIRED:commit", "MANDATORY:commit", "SUPPORTS:commit", "after the joined call:commit"]],
            ["joined scope, owner rolls back",
                () => rejected(a.run(async () => {
                    await a.run(() => both("joined"));
                    fail();
                })),
                ["a:begin", "a:rollback", "joined:rollback"]],
            ["NESTED released, owner commits: both pass to the owner",
                () => a.run(async () => {
                    await a.run(() => both("nested"), Propagation.NESTED);
                    events.push("body");
                }),
                ["a:begin", "a:savepoint", "a:release", "body", "a:commit", "nested:commit"]],
            ["NESTED rolled back, owner commits: commit hook discarded, rollback hook runs at the savepoint rollback",
                () => a.run(async () => {
                    await rejected(a.run(() => { both("nested"); fail(); }, Propagation.NESTED));
                    events.push("body");
                }),
                ["a:begin", "a:savepoint", "a:rollback to", "nested:rollback", "body", "a:commit"]],
        ];

        it.each(rows)("%s", async (_name, scenario, expected, logged = []) => {
            await scenario();
            expect(events).toEqual(expected);
            expect(a.logged).toEqual(logged);
            expect(b.logged).toEqual([]);
        });
    });

    describe("a finished inner transaction while an outer one is still active", () => {
        const cases = ["default outer, named inner", "named outer, default inner", "REQUIRES_NEW"].flatMap(nesting =>
            [false, true].flatMap(innerFails => [false, true].map(outerFails => [nesting, innerFails, outerFails] as const)));

        it.each(cases)("%s (inner fails: %s, outer fails: %s): by the inner outcome, never attached to the outer", async (nesting, innerFails, outerFails) => {
            const outer = nesting === "named outer, default inner" ? b : a;
            const inner = nesting === "REQUIRES_NEW" ? a : outer === a ? b : a;
            const operation = outer.run(async () => {
                let late!: Retained;
                const work = inner.run(() => {
                    late = retain();
                    if (innerFails) fail();
                }, nesting === "REQUIRES_NEW" ? Propagation.REQUIRES_NEW : Propagation.REQUIRED);
                await (innerFails ? rejected(work) : work);
                events.length = 0;
                late(() => both("late"));
                events.push("outer continues");
                if (outerFails) fail();
            });
            await (outerFails ? rejected(operation) : operation);
            const o = outer === a ? "a" : "b";
            expect(events).toEqual([innerFails ? "late:rollback" : "late:commit", "outer continues", outerFails ? `${o}:rollback` : `${o}:commit`]);
        });
    });

    describe("inside a running hook", () => {
        it.each([false, true])("no transaction is selected: afterCommit invokes now and afterRollback does nothing (rollback hook: %s)", async rollback => {
            const hook = () => {
                // The completing transaction is suspended here, by name as well.
                both("inner");
                both("explicit", DEFAULT_DATASOURCE);
                events.push("hook done");
            };
            const operation = a.run(() => {
                afterCommit(hook);
                void afterRollback(hook);
                if (rollback) fail();
            });
            await (rollback ? rejected(operation) : operation);
            expect(events).toEqual(["a:begin", rollback ? "a:rollback" : "a:commit", "inner:commit", "explicit:commit", "hook done"]);
        });

        it.each([false, true])("an enclosing active transaction is selected: both hooks queue on it (it fails: %s)", async outerFails => {
            const operation = a.run(async () => {
                await b.run(() => { afterCommit(() => { both("inner"); events.push("hook done"); }); });
                await rejected(b.run(() => {
                    void afterRollback(() => { both("from rollback hook"); events.push("rollback hook done"); });
                    fail();
                }));
                events.push("outer continues");
                if (outerFails) fail();
            });
            await (outerFails ? rejected(operation) : operation);
            expect(events).toEqual([
                "a:begin", "b:begin", "b:commit", "hook done", "b:begin", "b:rollback", "rollback hook done", "outer continues",
                ...(outerFails ? ["a:rollback", "inner:rollback", "from rollback hook:rollback"] : ["a:commit", "inner:commit", "from rollback hook:commit"]),
            ]);
        });

        it.each([false, true])("a finished transaction is selected: its outcome applies, although another one further out is active (it failed: %s)", async finishedFails => {
            const c = new HookManager("c", events);
            const outerName = Symbol("outer");
            useTransactionManager(c, outerName);
            try {
                await c.run(async () => {
                    let detached!: Retained;
                    const work = b.run(() => {
                        detached = retain();
                        if (finishedFails) fail();
                    });
                    await (finishedFails ? rejected(work) : work);
                    events.length = 0;
                    // Detached work that kept b's finished context completes a transaction of its own on a.
                    // Its hook then runs with a suspended, b finished and innermost, and c active further out.
                    await detached(() => a.run(() => {
                        afterCommit(() => {
                            expect(c.getCurrentTransaction()).toBeDefined();
                            both("in hook");
                            events.push("hook done");
                        });
                    }));
                    events.push("outer continues");
                });
            } finally { useTransactionManager(undefined as any, outerName); }
            expect(events).toEqual([
                "a:begin", "a:commit", finishedFails ? "in hook:rollback" : "in hook:commit", "hook done", "outer continues", "c:commit",
            ]);
        });
    });

    describe("while completion is in flight", () => {
        it.each([
            ["COMMIT", false, false, "during:commit"],
            ["ROLLBACK", true, false, "during:rollback"],
            ["a failing COMMIT", false, true, "during:rollback"],
            ["a failing ROLLBACK", true, true, "during:rollback"],
        ] as const)("a registration during %s is queued and dispatched by the eventual outcome", async (_name, applicationFails, completionFails, expected) => {
            if (completionFails) a[applicationFails ? "rollbackError" : "commitError"] = new Error("completion failed");
            let late!: Retained;
            a.during = () => {
                late(() => both("during"));
                events.push("registered");
            };
            const operation = a.run(() => {
                late = retain();
                if (applicationFails) fail();
            });
            if (applicationFails || completionFails) await expect(operation).rejects.toBeInstanceOf(Error);
            else await operation;
            expect(events).toEqual(["a:begin", applicationFails ? "a:rollback" : "a:commit", "registered", expected]);
        });

        it("publishes the outcome before the first hook runs", async () => {
            const seen: unknown[] = [];
            let late!: Retained;
            const observe = () => { seen.push(late(() => ({ ...a.state() }))); };
            await a.run(() => { late = retain(); afterCommit(observe); });
            await rejected(a.run(() => { late = retain(); void afterRollback(observe); fail(); }));
            a.commitError = new Error("commit failed");
            await rejected(a.run(() => { late = retain(); void afterRollback(observe); }), a.commitError);
            expect(seen).toMatchObject([
                { active: false, outcome: "committed" }, { active: false, outcome: "rolled-back" }, { active: false, outcome: "failed" },
            ]);
        });
    });

    describe("NESTED scopes follow their savepoint", () => {
        const nested = (callback: () => unknown) => a.run(callback, Propagation.NESTED);

        it("released, then the owner rolls back: the rollback hook runs once, with the owner's", async () => {
            await rejected(a.run(async () => {
                await nested(() => both("nested"));
                both("owner");
                fail();
            }));
            expect(events).toEqual(["a:begin", "a:savepoint", "a:release", "a:rollback", "nested:rollback", "owner:rollback"]);
        });

        it("rolled back, then the owner rolls back: the rollback hook ran at the savepoint and does not run again", async () => {
            await rejected(a.run(async () => {
                await rejected(nested(() => { both("nested"); fail(); }));
                both("owner");
                fail();
            }));
            expect(events).toEqual(["a:begin", "a:savepoint", "a:rollback to", "nested:rollback", "a:rollback", "owner:rollback"]);
        });

        it("keeps registration order when hooks pass to the owner", async () => {
            await a.run(async () => {
                both("before");
                await nested(() => both("nested"));
                both("after");
            });
            expect(events.slice(-3)).toEqual(["before:commit", "nested:commit", "after:commit"]);
        });

        it.each([
            ["inner released, outer released", false, false, ["a:commit", "outer:commit", "inner:commit"]],
            ["inner rolled back, outer released", true, false, ["inner:rollback", "a:commit", "outer:commit"]],
            // The inner scope was released into the outer one, so the outer savepoint rollback undoes both.
            ["inner released, outer rolled back", false, true, ["outer:rollback", "inner:rollback", "a:commit"]],
            ["inner rolled back, outer rolled back", true, true, ["inner:rollback", "outer:rollback", "a:commit"]],
        ] as const)("two levels: %s", async (_name, innerFails, outerFails, expected) => {
            await a.run(async () => {
                const outer = nested(async () => {
                    both("outer");
                    const inner = nested(() => { both("inner"); if (innerFails) fail(); });
                    await (innerFails ? rejected(inner) : inner);
                    if (outerFails) fail();
                });
                await (outerFails ? rejected(outer) : outer);
            });
            expect(events.filter(event => /:(commit|rollback)$/.test(event))).toEqual(expected);
        });

        it("a joined call inside a NESTED scope follows that scope", async () => {
            await a.run(async () => {
                await rejected(nested(async () => {
                    await a.run(() => both("joined in failed"));
                    fail();
                }));
                await nested(() => a.run(() => both("joined in released"), Propagation.MANDATORY));
                events.push("body");
            });
            expect(events).toEqual([
                "a:begin", "a:savepoint", "a:rollback to", "joined in failed:rollback",
                "a:savepoint", "a:release", "body", "a:commit", "joined in released:commit",
            ]);
        });

        it("a REQUIRES_NEW transaction inside a NESTED scope keeps its own hooks", async () => {
            await a.run(async () => {
                await rejected(nested(async () => {
                    await a.run(() => both("independent"), Propagation.REQUIRES_NEW);
                    fail();
                }));
            });
            expect(events).toEqual(["a:begin", "a:savepoint", "a:begin", "a:commit", "independent:commit", "a:rollback to", "a:commit"]);
        });

        it.each([false, true])("late registration from a released scope follows the enclosing scope (owner fails: %s)", async ownerFails => {
            const operation = a.run(async () => {
                let late!: Retained;
                await nested(() => { late = retain(); });
                late(() => both("late"));
                events.push("body");
                if (ownerFails) fail();
            });
            await (ownerFails ? rejected(operation) : operation);
            expect(events).toEqual([
                "a:begin", "a:savepoint", "a:release", "body", ...(ownerFails ? ["a:rollback", "late:rollback"] : ["a:commit", "late:commit"]),
            ]);
        });

        it.each([false, true])("late registration from a rolled-back scope: afterRollback invokes now, afterCommit does nothing (owner fails: %s)", async ownerFails => {
            const operation = a.run(async () => {
                let late!: Retained;
                await rejected(nested(() => { late = retain(); fail(); }));
                late(() => both("late"));
                events.push("body");
                if (ownerFails) fail();
            });
            await (ownerFails ? rejected(operation) : operation);
            expect(events).toEqual(["a:begin", "a:savepoint", "a:rollback to", "late:rollback", "body", ownerFails ? "a:rollback" : "a:commit"]);
        });

        it("late registration from a scope released into a scope that then rolled back follows the rollback", async () => {
            await a.run(async () => {
                let late!: Retained;
                await rejected(nested(async () => {
                    await nested(() => { late = retain(); });
                    fail();
                }));
                late(() => both("late"));
                events.push("body");
            });
            expect(events.slice(-3)).toEqual(["late:rollback", "body", "a:commit"]);
        });

        it("late registration from a scope after the owner finished follows the owner's outcome", async () => {
            let released!: Retained;
            let undone!: Retained;
            await a.run(async () => {
                await nested(() => { released = retain(); });
                await rejected(nested(() => { undone = retain(); fail(); }));
            });
            events.length = 0;
            released(() => both("released"));
            undone(() => both("undone"));
            expect(events).toEqual(["released:commit", "undone:rollback"]);
        });

        it("a hook registered inside a nested rollback hook joins the enclosing scope, which is still open", async () => {
            await a.run(async () => {
                await rejected(nested(() => {
                    void afterRollback(async () => {
                        events.push("nested rollback hook");
                        both("from hook");
                        // The owner is still usable: joined and NESTED work run on it.
                        await a.run(() => events.push("joined work"), Propagation.MANDATORY);
                        await nested(() => both("nested from hook"));
                    });
                    fail();
                }));
                events.push("body");
            });
            expect(events).toEqual([
                "a:begin", "a:savepoint", "a:rollback to", "nested rollback hook", "joined work", "a:savepoint", "a:release",
                "body", "a:commit", "from hook:commit", "nested from hook:commit",
            ]);
        });

        it("transactions started by a nested rollback hook use the owner's ordinary propagation rules", async () => {
            const joinedFailure = new Error("joined failure in hook");
            await expect(a.run(async () => {
                await rejected(nested(() => {
                    void afterRollback(async () => {
                        await a.run(() => both("independent"), Propagation.REQUIRES_NEW);
                        // A failing joined call marks the owner rollback-only, although the hook's error is only logged.
                        await a.run(() => { throw joinedFailure; });
                    });
                    fail();
                }));
                events.push("body");
            })).rejects.toMatchObject({ name: "UnexpectedRollbackError" });
            expect(events).toEqual([
                "a:begin", "a:savepoint", "a:rollback to", "a:begin", "a:commit", "independent:commit", "body", "a:rollback",
            ]);
            expect(a.logged).toEqual([["Transaction synchronization failed", joinedFailure]]);
        });

        it("runs a scope's rollback hooks in order, logging a failing one, before the nested call rejects", async () => {
            const hookError = new Error("hook failed");
            await a.run(async () => {
                const operation = nested(() => {
                    void afterRollback(async () => { await Promise.resolve(); events.push("first"); });
                    void afterRollback(() => { throw hookError; });
                    void afterRollback(mark("last"));
                    fail();
                }).catch(error => { events.push("rejected"); throw error; });
                await rejected(operation);
            });
            expect(events).toEqual(["a:begin", "a:savepoint", "a:rollback to", "first", "last", "rejected", "a:commit"]);
            expect(a.logged).toEqual([["Transaction synchronization failed", hookError]]);
        });

        it("registrations during the savepoint statements are dispatched by the scope's eventual outcome", async () => {
            await a.run(async () => {
                let late!: Retained;
                await nested(() => {
                    late = retain();
                    a.during = () => late(() => both("during release"));
                });
                await rejected(nested(() => {
                    late = retain();
                    a.during = () => late(() => both("during rollback"));
                    fail();
                }));
                events.push("body");
            });
            expect(events).toEqual([
                "a:begin", "a:savepoint", "a:release", "a:savepoint", "a:rollback to", "during rollback:rollback",
                "body", "a:commit", "during release:commit",
            ]);
        });

        it("a failed savepoint rollback is not a savepoint rollback: hooks pass to the owner, which then rolls back", async () => {
            a.savepointRollbackError = new Error("savepoint rollback failed");
            await expect(a.run(async () => {
                await rejected(nested(() => { both("nested"); fail(); }));
                events.push("body");
            })).rejects.toMatchObject({ name: "UnexpectedRollbackError" });
            expect(events).toEqual(["a:begin", "a:savepoint", "a:rollback to", "body", "a:rollback", "nested:rollback"]);
        });

        it("a failed savepoint release passes hooks to the owner", async () => {
            a.releaseSavepointError = new Error("release failed");
            await a.run(async () => {
                await rejected(nested(() => both("nested")), a.releaseSavepointError);
                events.push("body");
            });
            expect(events).toEqual(["a:begin", "a:savepoint", "a:release", "body", "a:commit", "nested:commit"]);
        });

        it.each([false, true])("a detached scope that outlives its transaction dispatches its hooks by the known outcome (owner fails: %s)", async ownerFails => {
            let resume!: () => void;
            const gate = new Promise<void>(resolve => { resume = resolve; });
            let detached!: Promise<unknown>;
            const hookError = new Error("late hook failed");
            const operation = a.run(() => {
                detached = nested(async () => {
                    both("detached");
                    afterCommit(() => { throw hookError; });
                    await gate;
                }).catch(error => error);
                if (ownerFails) fail();
            });
            await (ownerFails ? rejected(operation) : operation);
            events.length = 0;
            resume();
            expect(await detached).toMatchObject({ name: "TransactionClosedError" });
            expect(events).toEqual([ownerFails ? "detached:rollback" : "detached:commit"]);
            // Nobody is left to receive the error of a commit hook that runs this late.
            expect(a.logged).toEqual(ownerFails ? [] : [["Transaction synchronization failed", hookError]]);
        });

        it("a NESTED scope started by detached work of an ended scope passes its hooks to the nearest open scope", async () => {
            await a.run(async () => {
                let late!: Retained;
                await nested(() => { late = retain(); });
                await late(() => nested(() => both("detached nested")));
                events.push("body");
            });
            expect(events.slice(-3)).toEqual(["body", "a:commit", "detached nested:commit"]);
        });
    });

    describe("return values and errors", () => {
        const hookError = new Error("hook failed");

        it("an immediate afterCommit returns the callback's result and propagates its error", async () => {
            const value = Promise.resolve();
            let late!: Retained;
            await a.run(() => { late = retain(); });
            expect(afterCommit(() => value)).toBe(value);
            expect(late(() => afterCommit(() => value))).toBe(value);
            expect(late(() => afterCommit(() => undefined))).toBeUndefined();
            expect(() => late(() => afterCommit(() => { throw hookError; }))).toThrow(hookError);
            await expect(late(() => afterCommit(async () => { throw hookError; }))).rejects.toBe(hookError);
            expect(a.logged).toEqual([]);
        });

        it("a queued or ignored registration returns undefined from both hooks", async () => {
            let late!: Retained;
            await a.run(() => {
                late = retain();
                expect(afterCommit(mark("wrong"))).toBeUndefined();
                expect(afterRollback(mark("wrong"))).toBeUndefined();
                fail();
            }).catch(() => undefined);
            events.length = 0;
            expect(afterRollback(mark("wrong"))).toBeUndefined();
            expect(late(() => afterCommit(mark("wrong")))).toBeUndefined();
            await a.run(() => { late = retain(); });
            expect(late(() => afterRollback(mark("wrong")))).toBeUndefined();
            expect(events).toEqual(["a:begin", "a:commit"]);
        });

        it("an immediate afterRollback returns a promise that waits for the callback, logs its error and never rejects", async () => {
            let late!: Retained;
            await rejected(a.run(() => { late = retain(); fail(); }));
            events.length = 0;
            const returned = late(() => afterRollback(async () => {
                events.push("started");
                await Promise.resolve();
                events.push("finished");
            }));
            expect(returned).toBeInstanceOf(Promise);
            // The callback is invoked during the call, like an immediate afterCommit.
            expect(events).toEqual(["started"]);
            await returned;
            expect(events).toEqual(["started", "finished"]);
            await expect(late(() => afterRollback(mark("sync")))).resolves.toBeUndefined();
            await expect(late(() => afterRollback(() => { throw hookError; }))).resolves.toBeUndefined();
            await expect(late(() => afterRollback(async () => { throw hookError; }))).resolves.toBeUndefined();
            expect(a.logged).toEqual([
                ["Transaction synchronization failed", hookError], ["Transaction synchronization failed", hookError],
            ]);
        });

        it("an ignored promise from an immediate failing afterRollback is not an unhandled rejection", async () => {
            const unhandled = jest.fn();
            process.on("unhandledRejection", unhandled);
            try {
                let late!: Retained;
                await rejected(a.run(() => { late = retain(); fail(); }));
                late(() => { void afterRollback(async () => { throw hookError; }); });
                await new Promise(resolve => setImmediate(resolve));
                await new Promise(resolve => setImmediate(resolve));
            } finally { process.off("unhandledRejection", unhandled); }
            expect(unhandled).not.toHaveBeenCalled();
            expect(a.logged).toEqual([["Transaction synchronization failed", hookError]]);
        });

        it("an immediate afterRollback logs through the manager of the transaction it addresses", async () => {
            let late!: Retained;
            await a.run(async () => {
                await rejected(b.run(() => { late = retain(); fail(); }));
                await late(() => afterRollback(() => { throw hookError; }));
            });
            expect(a.logged).toEqual([]);
            expect(b.logged).toEqual([["Transaction synchronization failed", hookError]]);
        });

        it("a logger that throws does not make an immediate afterRollback reject", async () => {
            a.setLogger({ info() {}, warn() {}, debug() {}, error() { throw new Error("logger failed"); } });
            let late!: Retained;
            await rejected(a.run(() => { late = retain(); fail(); }));
            await expect(late(() => afterRollback(() => { throw hookError; }))).resolves.toBeUndefined();
        });
    });

    it("a finished state built outside a manager has no outcome and keeps the old meaning: nothing to wait for", () => {
        const state: TxState = {
            context: { transaction: { id: 0 }, metadata: { driverName: "hooks" } },
            active: false, rollbackOnly: false, savepointCounter: 0, afterCommit: [], afterRollback: [],
        };
        AsyncLocal.RunFrame({ txs: new Map([[a, state]]) }, () => both("hand-built"));
        expect(events).toEqual(["hand-built:commit"]);
        expect(state.afterCommit).toEqual([]);
        expect(state.afterRollback).toEqual([]);
    });

    describe("long-lived work created inside a transaction", () => {
        it.each([false, true])("a timer keeps registering both hooks without error after that transaction finished (rolled back: %s)", async rolledBack => {
            let timer!: ReturnType<typeof setInterval>;
            const errors: unknown[] = [];
            let ticks = 0;
            const done = new Promise<void>(resolve => {
                const operation = a.run(() => {
                    timer = setInterval(() => {
                        try {
                            both(`tick ${++ticks}`);
                            // Work with its own transaction registers on that transaction, as usual.
                            if (ticks === 2) void a.run(() => both("own")).then(resolve);
                        } catch (error) { errors.push(error); }
                    }, 1);
                    if (rolledBack) fail();
                });
                operation.catch(() => undefined);
            });
            try { await done; } finally { clearInterval(timer); }
            const kind = rolledBack ? "rollback" : "commit";
            expect(errors).toEqual([]);
            expect(events.slice(0, 4)).toEqual(["a:begin", `a:${kind}`, `tick 1:${kind}`, `tick 2:${kind}`]);
            expect(events.slice(4, 7)).toEqual(["a:begin", "a:commit", "own:commit"]);
            expect(events).not.toContain("own:rollback");
        });
    });
});
