import "reflect-metadata";
import {
    afterCommit, afterRollback, AsyncLocal, ctx, DatasourceSetupError, DEFAULT_DATASOURCE,
    getTransactionManager, GlobalTransactionManager, IllegalTransactionStateException, IsolationLevel,
    Logger, MetadataWrappedTransaction, NestedTransactionNotSupportedError, NoTransactionContextError,
    PlatformTransactionManager, Propagation, runInTransaction, Transactional, TransactionOptions,
    TransactionTimeoutError, useTransactionManager,
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
    protected async createSavepoint(tx: Tx, name: string): Promise<void> {
        this.events.push(`savepoint:${tx.id}:${name}`);
    }
    protected async rollbackToSavepoint(tx: Tx, name: string): Promise<void> {
        this.events.push(`rollbackTo:${tx.id}:${name}`);
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

    it("does not roll back when commit fails or run success/failure hooks", async () => {
        const error = new Error("commit failed");
        manager.commitError = error;
        const commitHook = jest.fn();
        const rollbackHook = jest.fn();
        await expect(manager.executeTransaction(Propagation.REQUIRED, () => {
            afterCommit(commitHook);
            afterRollback(rollbackHook);
        })).rejects.toBe(error);
        expect(manager.events).toEqual(["begin:1", "commit:1"]);
        expect(commitHook).not.toHaveBeenCalled();
        expect(rollbackHook).not.toHaveBeenCalled();
        expect(manager.getCurrentTransaction()).toBeUndefined();
    });

    it("preserves the original callback error when rollback fails and reports it to the logger", async () => {
        const error = new Error("original");
        const rollbackError = new Error("rollback failed");
        const log = logger();
        manager.setLogger(log);
        manager.rollbackError = rollbackError;
        const hook = jest.fn();
        await expect(manager.executeTransaction(Propagation.REQUIRED, () => {
            afterRollback(hook);
            throw error;
        })).rejects.toBe(error);
        expect(log.error).toHaveBeenCalledWith("Transaction rollback failed", rollbackError);
        expect(hook).toHaveBeenCalledTimes(1);
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

    it("runs afterCommit sequentially after commit, logs errors, and registers NESTED hooks on the outer", async () => {
        const log = logger();
        manager.setLogger(log);
        const hookError = new Error("hook");
        await manager.executeTransaction(Propagation.REQUIRED, async () => {
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
        });
        expect(manager.events).toEqual([
            "begin:1", "savepoint:1:tranjs_sp_1", "release:1:tranjs_sp_1", "commit:1", "first", "nested", "last",
        ]);
        expect(log.error).toHaveBeenCalledWith("Transaction synchronization failed", hookError);
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

    it("runInTransaction supports sync/async results, propagation, options, datasource and setup errors", async () => {
        expect(await runInTransaction(() => 42)).toBe(42);
        expect(await runInTransaction(async () => "async")).toBe("async");
        const b = new RecordingManager();
        useTransactionManager(b, datasourceB);
        await runInTransaction(() => expect(b.getCurrentTransaction()).toBeDefined(), {
            datasource: datasourceB, readOnly: true, isolationLevel: IsolationLevel.READ_COMMITTED,
        });
        expect(b.options).toEqual({ readOnly: true, isolationLevel: IsolationLevel.READ_COMMITTED });
        await runInTransaction(() => expect(manager.getCurrentTransaction()).toBeUndefined(), { propagation: Propagation.NEVER });
        await expect(runInTransaction(() => undefined, { datasource: "missing" })).rejects.toThrow(DatasourceSetupError);
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
