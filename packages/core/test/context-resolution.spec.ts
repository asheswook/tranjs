import { AsyncResource } from "node:async_hooks";
import {
    AsyncLocal, clearTransactionManager, DatasourceSetupError, DEFAULT_DATASOURCE,
    MetadataWrappedTransaction, NoTransactionContextError, PlatformTransactionManager,
    Propagation, TransactionClosedError, useTransactionManager,
} from "../src";
import type { TransactionFrame, TxState } from "../src/asyncLocal";
import { resolveContextManager } from "../src/internal/context";

interface Tx { id: number }

class FakeManager extends PlatformTransactionManager<Tx> {
    readonly events: string[] = [];
    private nextId = 0;

    constructor() { super(); }

    // Model the driver checks after manager resolution, without a database dependency.
    query(): Tx {
        this.assertCurrentTransactionOpen();
        const tx = this.getCurrentTransaction();
        if (!tx) throw new NoTransactionContextError();
        this.events.push(`query:${tx.id}`);
        return tx;
    }

    closeConnection(tx: Tx): void { this.getConnectionGate(tx).closed = true; }

    protected async beginTransaction(): Promise<MetadataWrappedTransaction<Tx>> {
        const transaction = { id: ++this.nextId };
        this.events.push(`begin:${transaction.id}`);
        return { transaction, metadata: { driverName: "fake" } };
    }

    protected async commitTransaction(tx: Tx): Promise<void> { this.events.push(`commit:${tx.id}`); }
    protected async rollbackTransaction(tx: Tx): Promise<void> { this.events.push(`rollback:${tx.id}`); }
    protected async createSavepoint(tx: Tx, name: string): Promise<void> { this.events.push(`savepoint:${tx.id}:${name}`); }
    protected async rollbackToSavepoint(tx: Tx, name: string): Promise<void> { this.events.push(`rollbackTo:${tx.id}:${name}`); }
    protected async releaseSavepoint(tx: Tx, name: string): Promise<void> { this.events.push(`release:${tx.id}:${name}`); }
}

function state(active = true): TxState {
    return {
        context: { transaction: { id: 100 }, metadata: { driverName: "fake" } },
        active, gate: { closed: false }, rollbackOnly: false, savepointCounter: 0,
        afterCommit: [], afterRollback: [],
    };
}

describe("driver context manager resolution", () => {
    const namedDatasource = Symbol("context-resolution");
    const missingDatasource = "context-resolution-missing";
    let defaultManager: FakeManager;
    let namedManager: FakeManager;

    beforeEach(() => {
        defaultManager = new FakeManager();
        namedManager = new FakeManager();
        clearTransactionManager();
        clearTransactionManager(namedDatasource);
        clearTransactionManager(missingDatasource);
    });

    afterEach(() => {
        clearTransactionManager();
        clearTransactionManager(namedDatasource);
        clearTransactionManager(missingDatasource);
    });

    it.each(["default", "named"] as const)("resolves the sole active %s owner without requiring another registration", async datasource => {
        const owner = datasource === "default" ? defaultManager : namedManager;
        useTransactionManager(owner, datasource === "default" ? DEFAULT_DATASOURCE : namedDatasource);
        await owner.executeTransaction(Propagation.REQUIRED, tx => {
            expect(resolveContextManager()).toBe(owner);
            expect((resolveContextManager() as FakeManager).query()).toBe(tx);
        });
    });

    it.each(["default to named", "named to default"] as const)("follows the innermost active owner in %s scopes and permits an explicit outer", async direction => {
        useTransactionManager(defaultManager);
        useTransactionManager(namedManager, namedDatasource);
        const outer = direction === "default to named" ? defaultManager : namedManager;
        const inner = outer === defaultManager ? namedManager : defaultManager;
        const outerName = outer === defaultManager ? DEFAULT_DATASOURCE : namedDatasource;
        await outer.executeTransaction(Propagation.REQUIRED, async outerTx => {
            expect(resolveContextManager()).toBe(outer);
            await inner.executeTransaction(Propagation.REQUIRED, innerTx => {
                expect(resolveContextManager()).toBe(inner);
                expect((resolveContextManager() as FakeManager).query()).toBe(innerTx);
                expect(resolveContextManager(outerName)).toBe(outer);
                expect((resolveContextManager(outerName) as FakeManager).query()).toBe(outerTx);
                expect(() => resolveContextManager(missingDatasource)).toThrow(DatasourceSetupError);
            });
            expect(resolveContextManager()).toBe(outer);
        });
    });

    it("rejects an omitted lookup outside a frame when only a named datasource is registered", () => {
        useTransactionManager(namedManager, namedDatasource);
        expect(() => resolveContextManager()).toThrow(DatasourceSetupError);
        expect(() => resolveContextManager(missingDatasource)).toThrow(DatasourceSetupError);
        expect(resolveContextManager(namedDatasource)).toBe(namedManager);
    });

    it("returns the registered default outside a frame and leaves the no-transaction error to the driver", () => {
        useTransactionManager(defaultManager);
        expect(resolveContextManager()).toBe(defaultManager);
        expect(resolveContextManager(DEFAULT_DATASOURCE)).toBe(defaultManager);
        expect(() => (resolveContextManager() as FakeManager).query()).toThrow(NoTransactionContextError);
    });

    it.each([DEFAULT_DATASOURCE, namedDatasource])("explicit %s lookup observes replacement and clearing while omitted lookup retains its owner", async datasource => {
        useTransactionManager(namedManager, datasource);
        const replacement = new FakeManager();
        await namedManager.executeTransaction(Propagation.REQUIRED, tx => {
            useTransactionManager(replacement, datasource);
            expect(resolveContextManager(datasource)).toBe(replacement);
            expect(() => (resolveContextManager(datasource) as FakeManager).query()).toThrow(NoTransactionContextError);
            expect(resolveContextManager()).toBe(namedManager);
            expect((resolveContextManager() as FakeManager).query()).toBe(tx);
            clearTransactionManager(datasource);
            expect(() => resolveContextManager(datasource)).toThrow(DatasourceSetupError);
            expect(resolveContextManager()).toBe(namedManager);
            expect((resolveContextManager() as FakeManager).query()).toBe(tx);
        });
        expect(replacement.events).toEqual([]);
    });

    it.each([Propagation.REQUIRED, Propagation.REQUIRES_NEW])("rejects a retained completed named %s scope instead of falling back to its active outer", async propagation => {
        useTransactionManager(defaultManager);
        useTransactionManager(namedManager, namedDatasource);
        let retained!: () => void;
        let outerTx!: Tx;
        let outerFinished = false;
        await defaultManager.executeTransaction(Propagation.REQUIRED, async tx => {
            outerTx = tx;
            const capture = () => namedManager.executeTransaction(propagation, () => {
                expect(resolveContextManager()).toBe(namedManager);
                retained = AsyncResource.bind(() => {
                    expect(AsyncLocal.Context?.transaction).toBe(outerFinished ? undefined : outerTx);
                    expect(() => resolveContextManager()).toThrow(TransactionClosedError);
                    // Explicit resolution does not perform liveness checks: drivers retain
                    // their class-check/assertion order and may still target the live outer.
                    expect(resolveContextManager(DEFAULT_DATASOURCE)).toBe(defaultManager);
                    if (!outerFinished) expect((resolveContextManager(DEFAULT_DATASOURCE) as FakeManager).query()).toBe(outerTx);
                    else expect(() => defaultManager.query()).toThrow(TransactionClosedError);
                    expect(resolveContextManager(namedDatasource)).toBe(namedManager);
                    expect(() => namedManager.query()).toThrow(TransactionClosedError);
                });
            });
            if (propagation === Propagation.REQUIRES_NEW) {
                await namedManager.executeTransaction(Propagation.REQUIRED, async namedOuter => {
                    await capture();
                    expect(namedManager.getCurrentTransaction()).toBe(namedOuter);
                    retained();
                    expect(resolveContextManager()).toBe(namedManager);
                });
            } else await capture();
            retained();
            expect(resolveContextManager()).toBe(defaultManager);
        });
        outerFinished = true;
        retained();
    });

    it("rejects a retained same-manager REQUIRES_NEW scope even after its outer transaction is restored", async () => {
        useTransactionManager(defaultManager);
        let retained!: () => void;
        await defaultManager.executeTransaction(Propagation.REQUIRED, async outer => {
            await defaultManager.executeTransaction(Propagation.REQUIRES_NEW, inner => {
                expect(inner).not.toBe(outer);
                retained = AsyncResource.bind(() => {
                    expect(AsyncLocal.Context).toBeUndefined();
                    expect(() => resolveContextManager()).toThrow(TransactionClosedError);
                    expect(resolveContextManager(DEFAULT_DATASOURCE)).toBe(defaultManager);
                    expect(() => defaultManager.query()).toThrow(TransactionClosedError);
                });
            });
            expect(defaultManager.getCurrentTransaction()).toBe(outer);
            expect(resolveContextManager()).toBe(defaultManager);
            expect(defaultManager.query()).toBe(outer);
            retained();
        });
        retained();
    });

    it.each([Propagation.REQUIRED, Propagation.MANDATORY, Propagation.SUPPORTS, Propagation.NESTED])("%s joins resolve the physical owner even when another datasource is innermost", async propagation => {
        useTransactionManager(namedManager, namedDatasource);
        useTransactionManager(defaultManager);
        await namedManager.executeTransaction(Propagation.REQUIRED, async ownerTx => {
            const owner = AsyncLocal.Frame!.txs.get(namedManager);
            await defaultManager.executeTransaction(Propagation.REQUIRED, async () => {
                expect(resolveContextManager()).toBe(defaultManager);
                await namedManager.executeTransaction(propagation, tx => {
                    expect(AsyncLocal.Frame!.txs.get(namedManager)).toBe(owner);
                    expect(resolveContextManager()).toBe(namedManager);
                    expect((resolveContextManager() as FakeManager).query()).toBe(ownerTx);
                    expect(tx).toBe(ownerTx);
                });
                expect(resolveContextManager()).toBe(defaultManager);
            });
        });
    });

    it("a failed NESTED scope does not close the resolved physical owner", async () => {
        useTransactionManager(namedManager, namedDatasource);
        const failure = new Error("savepoint failure");
        await namedManager.executeTransaction(Propagation.REQUIRED, async tx => {
            const owner = AsyncLocal.Frame!.txs.get(namedManager);
            let retained!: () => void;
            await expect(namedManager.executeTransaction(Propagation.NESTED, () => {
                expect(resolveContextManager()).toBe(namedManager);
                expect(AsyncLocal.Frame!.txs.get(namedManager)).toBe(owner);
                retained = AsyncResource.bind(() => {
                    expect(resolveContextManager()).toBe(namedManager);
                    expect(namedManager.query()).toBe(tx);
                });
                throw failure;
            })).rejects.toBe(failure);
            expect(owner!.active).toBe(true);
            expect(owner!.gate!.closed).toBe(false);
            retained();
            expect(resolveContextManager()).toBe(namedManager);
            expect(namedManager.query()).toBe(tx);
        });
        expect(namedManager.events).toContain("rollbackTo:1:tranjs_sp_1");
        expect(namedManager.events).toContain("commit:1");
        expect(namedManager.events).not.toContain("rollback:1");
    });

    it("NOT_SUPPORTED skips the suspended owner and resolves the active outer datasource", async () => {
        useTransactionManager(defaultManager);
        useTransactionManager(namedManager, namedDatasource);
        await defaultManager.executeTransaction(Propagation.REQUIRED, outer =>
            namedManager.executeTransaction(Propagation.REQUIRED, () =>
                namedManager.executeTransaction(Propagation.NOT_SUPPORTED, () => {
                    expect(AsyncLocal.Frame!.txs.get(namedManager)).toBeNull();
                    expect(AsyncLocal.Context?.transaction).toBe(outer);
                    expect(resolveContextManager()).toBe(defaultManager);
                    expect((resolveContextManager() as FakeManager).query()).toBe(outer);
                    expect(resolveContextManager(namedDatasource)).toBe(namedManager);
                    expect(() => namedManager.query()).toThrow(NoTransactionContextError);
                })));
    });

    it.each([false, true])("NOT_SUPPORTED with only null owners falls back to the default registration (registered: %s)", async registered => {
        if (registered) useTransactionManager(defaultManager);
        useTransactionManager(namedManager, namedDatasource);
        await namedManager.executeTransaction(Propagation.REQUIRED, () =>
            namedManager.executeTransaction(Propagation.NOT_SUPPORTED, () => {
                expect(AsyncLocal.Context).toBeUndefined();
                if (registered) {
                    expect(resolveContextManager()).toBe(defaultManager);
                    expect(() => (resolveContextManager() as FakeManager).query()).toThrow(NoTransactionContextError);
                } else expect(() => resolveContextManager()).toThrow(DatasourceSetupError);
            }));
    });

    it.each(["empty", "null"] as const)("an %s frame falls back to the registered default, not frame.current", kind => {
        const fixture = state();
        const frame: TransactionFrame = {
            txs: kind === "empty" ? new Map() : new Map([[namedManager, null]]),
            current: fixture.context,
        };
        AsyncLocal.RunFrame(frame, () => {
            expect(() => resolveContextManager()).toThrow(DatasourceSetupError);
            useTransactionManager(defaultManager);
            expect(resolveContextManager()).toBe(defaultManager);
            expect(() => defaultManager.query()).toThrow(NoTransactionContextError);
        });
    });

    it.each(["inactive", "closed gate", "closed parent root"] as const)("rejects a retained %s owner without skipping to a live outer", kind => {
        useTransactionManager(defaultManager);
        useTransactionManager(namedManager, namedDatasource);
        const outer = state();
        const inner = state(kind !== "inactive");
        if (kind === "closed parent root") inner.gate = { closed: false, parent: { closed: true } };
        AsyncLocal.RunFrame({
            txs: new Map([[defaultManager, outer], [namedManager, inner]]),
            current: inner.context,
        }, () => {
            if (kind === "closed gate") namedManager.closeConnection(inner.context.transaction as Tx);
            expect(inner.active).toBe(kind !== "inactive");
            expect(() => resolveContextManager()).toThrow(TransactionClosedError);
            expect(resolveContextManager(namedDatasource)).toBe(namedManager);
            expect(() => namedManager.query()).toThrow(TransactionClosedError);
            expect(resolveContextManager(DEFAULT_DATASOURCE)).toBe(defaultManager);
            expect(defaultManager.query()).toBe(outer.context.transaction);
        });
    });
});
