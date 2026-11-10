import "reflect-metadata";
import {
    afterCommit, afterRollback, AsyncLocal, ctx, DatasourceSetupError, DEFAULT_DATASOURCE,
    getTransactionManager, GlobalTransactionManager, IllegalTransactionStateException, IsolationLevel,
    Logger, MetadataWrappedTransaction, NestedTransactionNotSupportedError, NoTransactionContextError,
    PlatformTransactionManager, Propagation, transactional, Transactional, TransactionOptions,
    TransactionTimeoutError, useTransactionManager, ConcurrentNestedTransactionError,
    InvalidIsolationLevelError, UnexpectedRollbackError, TransactionSystemError,
} from "../src";

interface Tx { id: number }

class RecordingManager extends PlatformTransactionManager<Tx> {
    readonly events: string[] = [];
    options?: TransactionOptions;
    beginContext?: Tx;
    commitError?: Error;
    rollbackError?: Error;
    private nextId = 0;

    constructor() { super(); }

    checkDeadline() { return this.getRemainingTimeout(); }

    protected async beginTransaction(options?: TransactionOptions): Promise<MetadataWrappedTransaction<Tx>> {
        this.options = options;
        this.beginContext = this.getCurrentTransaction();
        const id = ++this.nextId;
        this.events.push(`begin:${id}`);
        return { transaction: { id }, metadata: { driverName: "recording" } };
    }

    protected async commitTransaction(tx: Tx): Promise<void> {
        this.events.push(`commit:${tx.id}`);
        if (this.commitError) throw this.commitError;
    }

    protected async rollbackTransaction(tx: Tx): Promise<void> {
        this.events.push(`rollback:${tx.id}`);
        if (this.rollbackError) throw this.rollbackError;
    }
}

class SavepointManager extends RecordingManager {
    savepointRollbackError?: Error;
    protected async createSavepoint(tx: Tx, name: string): Promise<void> {
        this.events.push(`savepoint:${tx.id}:${name}`);
    }
    protected async rollbackToSavepoint(tx: Tx, name: string): Promise<void> {
        this.events.push(`rollbackTo:${tx.id}:${name}`);
        if (this.savepointRollbackError) throw this.savepointRollbackError;
    }
    protected async releaseSavepoint(tx: Tx, name: string): Promise<void> {
        this.events.push(`release:${tx.id}:${name}`);
    }
}

const logger = (): Logger => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });

describe("transaction hardening", () => {
    let manager: SavepointManager;
    const datasourceB = Symbol("B");

    beforeEach(() => {
        manager = new SavepointManager();
        useTransactionManager(manager);
    });
    afterEach(() => {
        useTransactionManager(undefined as any);
        useTransactionManager(undefined as any, datasourceB);
        jest.restoreAllMocks();
    });

    it("registers, replaces, clears and resolves datasources with a live default binding", () => {
        expect(getTransactionManager()).toBe(manager);
        expect(GlobalTransactionManager).toBe(manager);
        const replacement = new RecordingManager();
        useTransactionManager(replacement, datasourceB);
        expect(getTransactionManager(datasourceB)).toBe(replacement);
        useTransactionManager(manager, datasourceB);
        expect(getTransactionManager(datasourceB)).toBe(manager);
        useTransactionManager(replacement);
        expect(GlobalTransactionManager).toBe(replacement);
        expect(getTransactionManager(DEFAULT_DATASOURCE)).toBe(replacement);
        useTransactionManager(undefined as any);
        expect(GlobalTransactionManager).toBeUndefined();
        expect(() => getTransactionManager()).toThrow(DatasourceSetupError);
        expect(() => getTransactionManager("missing")).toThrow("missing");
    });

    it("preserves commit errors without rollback and runs rollback hooks", async () => {
        const error = new Error("commit failed");
        manager.commitError = error;
        const rollbackError = new Error("rollback failed");
        manager.rollbackError = rollbackError;
        const log = logger();
        manager.setLogger(log);
        const commitHook = jest.fn();
        const rollbackHook = jest.fn();
        await expect(manager.executeTransaction(Propagation.REQUIRED, () => {
            afterCommit(commitHook);
            afterRollback(rollbackHook);
        })).rejects.toBe(error);
        expect(manager.events).toEqual(["begin:1", "commit:1"]);
        expect(log.error).not.toHaveBeenCalled();
        expect(commitHook).not.toHaveBeenCalled();
        expect(rollbackHook).toHaveBeenCalledTimes(1);
        expect(manager.getCurrentTransaction()).toBeUndefined();
    });

    it("throws TransactionSystemError with both errors when rollback fails and logs the application error", async () => {
        const error = new Error("original");
        const rollbackError = new Error("rollback failed");
        const log = logger();
        manager.setLogger(log);
        manager.rollbackError = rollbackError;
        const hook = jest.fn();
        await expect(manager.executeTransaction(Propagation.REQUIRED, () => {
            afterRollback(hook);
            throw error;
        })).rejects.toMatchObject({
            name: "TransactionSystemError",
            message: "Transaction rollback failed after application error",
            cause: rollbackError, applicationError: error,
        });
        expect(log.error).toHaveBeenCalledWith("Transaction application error before rollback failure", error);
        expect(hook).toHaveBeenCalledTimes(1);
    });

    it.each([Propagation.REQUIRED, Propagation.MANDATORY, Propagation.SUPPORTS])(
        "%s joined failure marks rollback-only even when caught by the owner", async propagation => {
            const error = new Error("joined failure");
            const commitHook = jest.fn();
            const rollbackHook = jest.fn();
            // Spring semantics: joined failure marks rollback-only
            await expect(manager.executeTransaction(Propagation.REQUIRED, async () => {
                afterCommit(commitHook);
                afterRollback(rollbackHook);
                await expect(manager.executeTransaction(propagation, () => { throw error; })).rejects.toBe(error);
            })).rejects.toThrow(UnexpectedRollbackError);
            expect(manager.events).toEqual(["begin:1", "rollback:1"]);
            expect(commitHook).not.toHaveBeenCalled();
            expect(rollbackHook).toHaveBeenCalledTimes(1);
        },
    );

    it("does not mark rollback-only for an error caught within the same callback", async () => {
        await manager.executeTransaction(Propagation.REQUIRED, () => {
            try { throw new Error("handled locally"); } catch {}
        });
        expect(manager.events).toEqual(["begin:1", "commit:1"]);
    });

    it.each([Propagation.SUPPORTS, Propagation.NOT_SUPPORTED, Propagation.NEVER])(
        "%s without a transaction simply rethrows failures", async propagation => {
            const error = new Error("no transaction");
            await expect(manager.executeTransaction(propagation, () => { throw error; })).rejects.toBe(error);
            expect(manager.events).toEqual([]);
        },
    );

    it.each(["timeout", "rollback-only"])("wraps rollback failure after %s", async reason => {
        const rollbackError = new Error("rollback failed");
        manager.rollbackError = rollbackError;
        manager.setLogger(logger());
        let now = 100;
        jest.spyOn(Date, "now").mockImplementation(() => now);
        const result = manager.executeTransaction(Propagation.REQUIRED, async () => {
            if (reason === "timeout") now += 11;
            else await manager.executeTransaction(Propagation.REQUIRED, () => { throw new Error("joined"); }).catch(() => {});
        }, reason === "timeout" ? { timeout: 10 } : undefined);
        await expect(result).rejects.toBeInstanceOf(TransactionSystemError);
        await expect(result).rejects.toMatchObject({
            cause: rollbackError,
            applicationError: expect.any(reason === "timeout" ? TransactionTimeoutError : UnexpectedRollbackError),
        });
        expect(manager.events).toEqual(["begin:1", "rollback:1"]);
    });

    it.each(["success", "callback throws", "rollback throws", "commit throws", "timeout", "rollback-only", "afterCommit throws"])(
        "releases exactly once after %s with the completion failure flag", async path => {
            class ReleasingManager extends RecordingManager {
                protected async releaseTransaction(tx: Tx, failed: boolean) {
                    this.events.push(`release:${tx.id}:${failed}`);
                }
            }
            const releasing = new ReleasingManager();
            useTransactionManager(releasing);
            releasing.setLogger(logger());
            let now = 100;
            jest.spyOn(Date, "now").mockImplementation(() => now);
            if (path === "commit throws") releasing.commitError = new Error("commit failed");
            if (path === "rollback throws") releasing.rollbackError = new Error("rollback failed");
            const result = releasing.executeTransaction(Propagation.REQUIRED, async () => {
                if (path === "callback throws" || path === "rollback throws") throw new Error("application error");
                if (path === "timeout") now += 11;
                if (path === "rollback-only") {
                    await releasing.executeTransaction(Propagation.REQUIRED, () => { throw new Error("joined"); }).catch(() => {});
                }
                if (path === "afterCommit throws") afterCommit(() => { throw new Error("hook"); });
            }, path === "timeout" ? { timeout: 10 } : undefined);
            if (path === "success") await expect(result).resolves.toBeUndefined();
            else await expect(result).rejects.toThrow();
            const commits = ["success", "commit throws", "afterCommit throws"].includes(path);
            const failed = path === "commit throws" || path === "rollback throws";
            expect(releasing.events).toEqual([
                "begin:1", commits ? "commit:1" : "rollback:1", `release:1:${failed}`,
            ]);
            expect(releasing.events.filter(event => event.startsWith("release:"))).toHaveLength(1);
        },
    );

    it.each(["commit failure", "rollback"])("legacy-style manager releases once on %s", async path => {
        class LegacyManager extends RecordingManager {
            releases = 0;
            protected async commitTransaction(tx: Tx) {
                try { await super.commitTransaction(tx); } finally { this.releases++; }
            }
            protected async rollbackTransaction(tx: Tx) {
                try { await super.rollbackTransaction(tx); } finally { this.releases++; }
            }
        }
        const legacy = new LegacyManager();
        const error = new Error(path);
        if (path === "commit failure") legacy.commitError = error;
        await expect(legacy.executeTransaction(Propagation.REQUIRED, () => {
            if (path === "rollback") throw error;
        })).rejects.toBe(error);
        expect(legacy.releases).toBe(1);
        expect(legacy.events).toEqual(["begin:1", path === "rollback" ? "rollback:1" : "commit:1"]);
    });

    it("SUPPORTS runs without a tx or joins the current physical transaction", async () => {
        await manager.executeTransaction(Propagation.SUPPORTS, tx => {
            expect(tx).toBeUndefined();
            expect(() => ctx()).toThrow(NoTransactionContextError);
        });
        expect(manager.events).toEqual([]);
        await manager.executeTransaction(Propagation.REQUIRED, outer =>
            manager.executeTransaction(Propagation.SUPPORTS, inner => {
                expect(inner).toBe(outer);
                expect(ctx()).toBe(outer);
            }));
        expect(manager.events).toEqual(["begin:1", "commit:1"]);
    });

    it("NOT_SUPPORTED suspends only this manager and restores it after success and failure", async () => {
        await manager.executeTransaction(Propagation.REQUIRED, async outer => {
            const parent = AsyncLocal.Frame;
            await manager.executeTransaction(Propagation.NOT_SUPPORTED, tx => {
                expect(tx).toBeUndefined();
                expect(manager.getCurrentTransaction()).toBeUndefined();
                expect(AsyncLocal.Context).toBeUndefined();
                expect(() => ctx()).toThrow("No transaction context available");
                expect(AsyncLocal.Frame).not.toBe(parent);
            });
            expect(manager.getCurrentTransaction()).toBe(outer);
            await expect(manager.executeTransaction(Propagation.NOT_SUPPORTED, () => {
                throw new Error("no tx");
            })).rejects.toThrow("no tx");
            expect(manager.getCurrentTransaction()).toBe(outer);
            expect(AsyncLocal.Frame).toBe(parent);
        });
        expect(manager.events).toEqual(["begin:1", "commit:1"]);
    });

    it("NEVER runs without a tx and rejects an existing transaction", async () => {
        await manager.executeTransaction(Propagation.NEVER, tx => {
            expect(tx).toBeUndefined();
            expect(AsyncLocal.Context).toBeUndefined();
        });
        await manager.executeTransaction(Propagation.REQUIRED, async () => {
            await expect(manager.executeTransaction(Propagation.NEVER, () => undefined))
                .rejects.toThrow(IllegalTransactionStateException);
        });
        expect(manager.events).toEqual(["begin:1", "commit:1"]);
    });

    it("NESTED starts a physical transaction without an outer transaction", async () => {
        await manager.executeTransaction(Propagation.NESTED, tx => expect(tx.id).toBe(1));
        expect(manager.events).toEqual(["begin:1", "commit:1"]);
    });

    it("NESTED releases on success, rolls back to a unique savepoint on error, and keeps the outer alive", async () => {
        const error = new Error("nested");
        await manager.executeTransaction(Propagation.REQUIRED, async outer => {
            await manager.executeTransaction(Propagation.NESTED, tx => expect(tx).toBe(outer));
            await expect(manager.executeTransaction(Propagation.NESTED, tx => {
                expect(tx).toBe(outer);
                throw error;
            })).rejects.toBe(error);
            expect(manager.getCurrentTransaction()).toBe(outer);
            await manager.executeTransaction(Propagation.NESTED, () => undefined);
        });
        expect(manager.events).toEqual([
            "begin:1", "savepoint:1:tranjs_sp_1", "release:1:tranjs_sp_1",
            "savepoint:1:tranjs_sp_2", "rollbackTo:1:tranjs_sp_2",
            "savepoint:1:tranjs_sp_3", "release:1:tranjs_sp_3", "commit:1",
        ]);
    });

    it("old managers work without savepoints and default NESTED hooks reject clearly", async () => {
        const oldManager = new RecordingManager();
        await oldManager.executeTransaction(Propagation.REQUIRED, async () => {
            await expect(oldManager.executeTransaction(Propagation.NESTED, () => undefined))
                .rejects.toThrow(NestedTransactionNotSupportedError);
        });
        expect(oldManager.events).toEqual(["begin:1", "commit:1"]);
    });

    it("commits the outer after a NESTED failure originating in an inner REQUIRED", async () => {
        const error = new Error("joined inside nested");
        await manager.executeTransaction(Propagation.REQUIRED, async () => {
            await expect(manager.executeTransaction(Propagation.NESTED, () =>
                manager.executeTransaction(Propagation.REQUIRED, () => { throw error; }),
            )).rejects.toBe(error);
        });
        expect(manager.events).toEqual([
            "begin:1", "savepoint:1:tranjs_sp_1", "rollbackTo:1:tranjs_sp_1", "commit:1",
        ]);
    });

    it("rolls back the savepoint and throws UnexpectedRollbackError when NESTED catches a joined failure", async () => {
        await manager.executeTransaction(Propagation.REQUIRED, async () => {
            await expect(manager.executeTransaction(Propagation.NESTED, async () => {
                await manager.executeTransaction(Propagation.REQUIRED, () => {
                    throw new Error("caught in nested");
                }).catch(() => {});
            })).rejects.toThrow(UnexpectedRollbackError);
        });
        expect(manager.events).toEqual([
            "begin:1", "savepoint:1:tranjs_sp_1", "rollbackTo:1:tranjs_sp_1", "commit:1",
        ]);
    });

    it("clears even pre-existing outer rollback-only on successful savepoint rollback, matching Spring", async () => {
        const error = new Error("nested failure");
        await manager.executeTransaction(Propagation.REQUIRED, async () => {
            await manager.executeTransaction(Propagation.REQUIRED, () => {
                throw new Error("outer already rollback-only");
            }).catch(() => {});
            await expect(manager.executeTransaction(Propagation.NESTED, () => { throw error; })).rejects.toBe(error);
        });
        // Spring's rollbackToSavepoint resets the whole connection flag, not just changes since the savepoint.
        expect(manager.events).toEqual([
            "begin:1", "savepoint:1:tranjs_sp_1", "rollbackTo:1:tranjs_sp_1", "commit:1",
        ]);
    });

    it("re-detects an expired deadline at owner commit after NESTED rollback clears rollback-only", async () => {
        let now = 100;
        jest.spyOn(Date, "now").mockImplementation(() => now);
        await expect(manager.executeTransaction(Propagation.REQUIRED, async () => {
            await expect(manager.executeTransaction(Propagation.NESTED, () => {
                now += 11;
                manager.checkDeadline();
            })).rejects.toThrow(TransactionTimeoutError);
            expect(AsyncLocal.Frame!.txs.get(manager)!.rollbackOnly).toBe(false);
        }, { timeout: 10 })).rejects.toThrow(TransactionTimeoutError);
        expect(manager.events).toEqual([
            "begin:1", "savepoint:1:tranjs_sp_1", "rollbackTo:1:tranjs_sp_1", "rollback:1",
        ]);
    });

    it("rejects concurrent NESTED siblings in Promise.all before creating a second savepoint", async () => {
        await manager.executeTransaction(Propagation.REQUIRED, async () => {
            const results = await Promise.all([1, 2].map(() =>
                manager.executeTransaction(Propagation.NESTED, async () => {
                    await Promise.resolve();
                }).then(() => "ok", error => error)));
            expect(results[0]).toBe("ok");
            expect(results[1]).toBeInstanceOf(ConcurrentNestedTransactionError);
            await manager.executeTransaction(Propagation.NESTED, () => undefined);
        });
        expect(manager.events).toEqual([
            "begin:1", "savepoint:1:tranjs_sp_1", "release:1:tranjs_sp_1",
            "savepoint:1:tranjs_sp_2", "release:1:tranjs_sp_2", "commit:1",
        ]);
    });

    it("allows genuine recursive NESTED scopes", async () => {
        await manager.executeTransaction(Propagation.REQUIRED, () =>
            manager.executeTransaction(Propagation.NESTED, () =>
                manager.executeTransaction(Propagation.NESTED, () => undefined)));
        expect(manager.events).toEqual([
            "begin:1", "savepoint:1:tranjs_sp_1", "savepoint:1:tranjs_sp_2",
            "release:1:tranjs_sp_2", "release:1:tranjs_sp_1", "commit:1",
        ]);
    });

    it("does not let a completed NESTED sibling clear a newer sibling's guard", async () => {
        let startedA!: () => void;
        const callbackAStarted = new Promise<void>(resolve => { startedA = resolve; });
        let startedB!: () => void;
        const callbackBStarted = new Promise<void>(resolve => { startedB = resolve; });
        let releaseB!: () => void;
        const holdB = new Promise<void>(resolve => { releaseB = resolve; });
        const callbackC = jest.fn();
        await manager.executeTransaction(Propagation.REQUIRED, async () => {
            const a = manager.executeTransaction(Propagation.NESTED, () => { startedA(); });
            await callbackAStarted;
            // A has released its savepoint and cleared its guard, but its returned
            // promise has not settled. Its later cleanup must not clear B's guard.
            await Promise.resolve();
            await Promise.resolve();
            const b = manager.executeTransaction(Propagation.NESTED, async () => {
                startedB();
                await holdB;
            });
            try {
                await a;
                await callbackBStarted;
                await expect(manager.executeTransaction(Propagation.NESTED, callbackC))
                    .rejects.toBeInstanceOf(ConcurrentNestedTransactionError);
                expect(callbackC).not.toHaveBeenCalled();
            } finally {
                releaseB();
                await b;
            }
        });
        expect(manager.events).toEqual([
            "begin:1", "savepoint:1:tranjs_sp_1", "release:1:tranjs_sp_1",
            "savepoint:1:tranjs_sp_2", "release:1:tranjs_sp_2", "commit:1",
        ]);
    });

    it("marks failed savepoint rollback rollback-only and rolls back the physical owner with hooks", async () => {
        const rollbackError = new Error("savepoint rollback failed");
        manager.savepointRollbackError = rollbackError;
        const log = logger();
        manager.setLogger(log);
        const rollbackHook = jest.fn();
        const commitHook = jest.fn();
        const nestedError = new Error("nested failed");
        await expect(manager.executeTransaction(Propagation.REQUIRED, async () => {
            afterCommit(commitHook);
            afterRollback(rollbackHook);
            await expect(manager.executeTransaction(Propagation.NESTED, () => {
                throw nestedError;
            })).rejects.toBe(nestedError);
        })).rejects.toThrow(UnexpectedRollbackError);
        expect(new UnexpectedRollbackError().message).toContain("marked rollback-only");
        expect(manager.events).toEqual([
            "begin:1", "savepoint:1:tranjs_sp_1", "rollbackTo:1:tranjs_sp_1", "rollback:1",
        ]);
        expect(log.error).toHaveBeenCalledWith("Savepoint rollback failed", rollbackError);
        expect(rollbackHook).toHaveBeenCalledTimes(1);
        expect(commitHook).not.toHaveBeenCalled();
    });

    it("validates isolation before beginning a physical transaction", async () => {
        const callback = jest.fn();
        await expect(manager.executeTransaction(Propagation.REQUIRED, callback, {
            isolationLevel: "READ COMMITTED; COMMIT; SELECT 1 --" as IsolationLevel,
        })).rejects.toThrow(InvalidIsolationLevelError);
        expect(manager.events).toEqual([]);
        expect(callback).not.toHaveBeenCalled();
    });

    it("REQUIRES_NEW suspends before begin and restores the outer after success and rollback", async () => {
        await manager.executeTransaction(Propagation.REQUIRED, async outer => {
            await manager.executeTransaction(Propagation.REQUIRES_NEW, inner => {
                expect(inner).not.toBe(outer);
                expect(manager.beginContext).toBeUndefined();
                expect(manager.getCurrentTransaction()).toBe(inner);
                expect(AsyncLocal.Context?.transaction).toBe(inner);
            });
            expect(manager.getCurrentTransaction()).toBe(outer);
            expect(ctx()).toBe(outer);
            await expect(manager.executeTransaction(Propagation.REQUIRES_NEW, () => {
                throw new Error("inner");
            })).rejects.toThrow("inner");
            expect(manager.getCurrentTransaction()).toBe(outer);
            expect(ctx()).toBe(outer);
        });
        expect(manager.events).toEqual(["begin:1", "begin:2", "commit:2", "begin:3", "rollback:3", "commit:1"]);
    });

    it("passes isolation, readOnly and timeout to beginTransaction", async () => {
        const options = { isolationLevel: IsolationLevel.SERIALIZABLE, readOnly: true, timeout: 1000 };
        await manager.executeTransaction(Propagation.REQUIRED, () => "ok", options);
        expect(manager.options).toEqual(options);
    });

    it.each([NaN, Infinity, -1, 2147483648])("rejects invalid timeout %s before beginning", async timeout => {
        const callback = jest.fn();
        await expect(manager.executeTransaction(Propagation.REQUIRED, callback, { timeout })).rejects.toThrow(RangeError);
        expect(callback).not.toHaveBeenCalled();
        expect(manager.events).toEqual([]);
    });

    it("accepts the maximum timer-safe timeout", async () => {
        await manager.executeTransaction(Propagation.REQUIRED, () => undefined, { timeout: 2147483647 });
        expect(manager.events).toEqual(["begin:1", "commit:1"]);
    });

    it("rolls back and runs rollback hooks when elapsed time exceeds timeout", async () => {
        let now = 100;
        jest.spyOn(Date, "now").mockImplementation(() => now);
        const hook = jest.fn();
        await expect(manager.executeTransaction(Propagation.REQUIRED, () => {
            afterRollback(hook);
            now += 11;
        }, { timeout: 10 })).rejects.toThrow(TransactionTimeoutError);
        expect(manager.events).toEqual(["begin:1", "rollback:1"]);
        expect(hook).toHaveBeenCalledTimes(1);
    });

    it("checks the remaining deadline before a query and rolls back even if the timeout is caught", async () => {
        let now = 100;
        jest.spyOn(Date, "now").mockImplementation(() => now);
        const query = jest.fn(() => manager.checkDeadline());
        expect(manager.checkDeadline()).toBeUndefined();
        await expect(manager.executeTransaction(Propagation.REQUIRED, () => {
            expect(manager.checkDeadline()).toBe(10);
            now += 4;
            expect(manager.checkDeadline()).toBe(6);
            now += 6;
            expect(query).toThrow(TransactionTimeoutError);
        }, { timeout: 10 })).rejects.toThrow(TransactionTimeoutError);
        expect(manager.events).toEqual(["begin:1", "rollback:1"]);
    });

    it("inherits deadlines in joined scopes and suspends them for REQUIRES_NEW", async () => {
        let now = 100;
        jest.spyOn(Date, "now").mockImplementation(() => now);
        await manager.executeTransaction(Propagation.REQUIRED, async () => {
            now += 4;
            await manager.executeTransaction(Propagation.REQUIRED, () => {
                expect(manager.checkDeadline()).toBe(6);
            }, { timeout: 1000 });
            await manager.executeTransaction(Propagation.REQUIRES_NEW, () => {
                expect(manager.checkDeadline()).toBeUndefined();
            });
            expect(manager.checkDeadline()).toBe(6);
        }, { timeout: 10 });
    });

    it("keeps datasource transactions independent and exposes the innermost active scope", async () => {
        const b = new RecordingManager();
        useTransactionManager(b, datasourceB);
        await manager.executeTransaction(Propagation.REQUIRED, async txA => {
            expect(b.getCurrentTransaction()).toBeUndefined();
            await b.executeTransaction(Propagation.REQUIRED, async txB => {
                expect(txB).not.toBe(txA);
                expect(manager.getCurrentTransaction()).toBe(txA);
                expect(b.getCurrentTransaction()).toBe(txB);
                expect(ctx()).toBe(txB);
                await manager.executeTransaction(Propagation.REQUIRED, joinedA => {
                    expect(joinedA).toBe(txA);
                    expect(AsyncLocal.Context?.transaction).toBe(txA);
                });
                expect(ctx()).toBe(txB);
                await b.executeTransaction(Propagation.NOT_SUPPORTED, () => {
                    expect(b.getCurrentTransaction()).toBeUndefined();
                    expect(ctx()).toBe(txA);
                });
                await manager.executeTransaction(Propagation.NOT_SUPPORTED, () => {
                    expect(manager.getCurrentTransaction()).toBeUndefined();
                    expect(ctx()).toBe(txB);
                });
            });
            expect(ctx()).toBe(txA);
            expect(b.getCurrentTransaction()).toBeUndefined();
        });
        expect(manager.events).toEqual(["begin:1", "commit:1"]);
        expect(b.events).toEqual(["begin:1", "commit:1"]);
    });

    it("copies scope maps so concurrent sibling scopes do not replace each other's transaction", async () => {
        await manager.executeTransaction(Propagation.REQUIRED, async outer => {
            await Promise.all([1, 2].map(() => manager.executeTransaction(Propagation.REQUIRES_NEW, async inner => {
                await Promise.resolve();
                expect(manager.getCurrentTransaction()).toBe(inner);
                expect(ctx()).toBe(inner);
            })));
            expect(manager.getCurrentTransaction()).toBe(outer);
        });
        expect(manager.events.filter(event => event.startsWith("commit"))).toHaveLength(3);
    });

    it("runs afterCommit sequentially after commit, propagates the first error, and stops remaining hooks", async () => {
        const log = logger();
        manager.setLogger(log);
        const hookError = new Error("hook");
        await expect(manager.executeTransaction(Propagation.REQUIRED, async () => {
            afterCommit(async () => {
                expect(manager.getCurrentTransaction()).toBeUndefined();
                await Promise.resolve();
                manager.events.push("first");
            });
            await manager.executeTransaction(Propagation.NESTED, () => {
                afterCommit(() => { manager.events.push("nested"); });
                afterRollback(() => { manager.events.push("wrong"); });
            });
            expect(manager.events).not.toContain("nested");
            afterCommit(() => { throw hookError; });
            afterCommit(() => { manager.events.push("last"); });
        })).rejects.toBe(hookError);
        expect(manager.events).toEqual([
            "begin:1", "savepoint:1:tranjs_sp_1", "release:1:tranjs_sp_1", "commit:1", "first", "nested",
        ]);
        expect(log.error).not.toHaveBeenCalled();
    });

    it("runs afterRollback sequentially after physical rollback, including hooks from failed NESTED scopes", async () => {
        const log = logger();
        manager.setLogger(log);
        const error = new Error("outer");
        await expect(manager.executeTransaction(Propagation.REQUIRED, async () => {
            afterRollback(async () => {
                await Promise.resolve();
                manager.events.push("first");
            });
            await expect(manager.executeTransaction(Propagation.NESTED, () => {
                afterRollback(() => { manager.events.push("nested"); });
                throw new Error("nested");
            })).rejects.toThrow("nested");
            expect(manager.events).not.toContain("nested");
            afterRollback(() => { throw new Error("hook"); });
            afterRollback(() => { manager.events.push("last"); });
            afterCommit(() => { manager.events.push("wrong"); });
            throw error;
        })).rejects.toBe(error);
        expect(manager.events).toEqual([
            "begin:1", "savepoint:1:tranjs_sp_1", "rollbackTo:1:tranjs_sp_1", "rollback:1", "first", "nested", "last",
        ]);
        expect(log.error).toHaveBeenCalledTimes(1);
    });

    it("runs afterCommit immediately outside a transaction, ignores afterRollback and targets the selected datasource", async () => {
        const immediate = jest.fn();
        const ignored = jest.fn();
        await afterCommit(immediate);
        afterRollback(ignored);
        expect(immediate).toHaveBeenCalledTimes(1);
        expect(ignored).not.toHaveBeenCalled();
        const b = new RecordingManager();
        useTransactionManager(b, datasourceB);
        const order: string[] = [];
        await manager.executeTransaction(Propagation.REQUIRED, async () => {
            await b.executeTransaction(Propagation.REQUIRED, () => {
                afterCommit(() => { order.push("A"); });
                afterCommit(() => { order.push("B"); }, datasourceB);
            });
            expect(order).toEqual(["B"]);
        });
        expect(order).toEqual(["B", "A"]);
    });

    it("transactional supports sync/async results, propagation, options, datasource and setup errors", async () => {
        expect(await transactional(() => 42)()).toBe(42);
        expect(await transactional(async () => "async")()).toBe("async");
        const b = new RecordingManager();
        useTransactionManager(b, datasourceB);
        await transactional(() => expect(b.getCurrentTransaction()).toBeDefined(), {
            datasource: datasourceB, readOnly: true, isolationLevel: IsolationLevel.READ_COMMITTED,
        })();
        expect(b.options).toEqual({ readOnly: true, isolationLevel: IsolationLevel.READ_COMMITTED });
        await transactional(() => expect(manager.getCurrentTransaction()).toBeUndefined(), { propagation: Propagation.NEVER })();
        await expect(transactional(() => undefined, { datasource: "missing" })()).rejects.toThrow(DatasourceSetupError);
    });

    it("decorator resolves config lazily, preserves this, arguments, method name and reflect metadata", async () => {
        const key = Symbol("metadata");
        const originalMetadata = { role: "reader" };
        function metadata(target: object, property: string, descriptor: PropertyDescriptor): void {
            Reflect.defineMetadata(key, originalMetadata, descriptor.value);
        }
        class Service {
            prefix = "result";

            @Transactional({ datasource: datasourceB, readOnly: true, isolationLevel: IsolationLevel.REPEATABLE_READ })
            @metadata
            async execute(value: number) {
                expect(getTransactionManager(datasourceB).getCurrentTransaction()).toBeDefined();
                return `${this.prefix}:${value}`;
            }
        }
        expect(Service.prototype.execute.name).toBe("execute");
        expect(Reflect.getMetadata(key, Service.prototype.execute)).toBe(originalMetadata);
        const service = new Service();
        await expect(service.execute(1)).rejects.toThrow(DatasourceSetupError);
        const b = new RecordingManager();
        useTransactionManager(b, datasourceB);
        expect(await service.execute(7)).toBe("result:7");
        expect(b.options).toEqual({ readOnly: true, isolationLevel: IsolationLevel.REPEATABLE_READ });
        expect(manager.events).toEqual([]);
    });
});
