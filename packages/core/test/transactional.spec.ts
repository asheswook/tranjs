import {
    clearTransactionManager, DatasourceSetupError, IllegalTransactionStateException, IsolationLevel,
    MetadataWrappedTransaction, PlatformTransactionManager, Propagation, TransactionConfig,
    TransactionOptions, transactional, useTransactionManager,
} from "../src";

interface Tx { id: number }

class RecordingManager extends PlatformTransactionManager<Tx> {
    readonly events: string[] = [];
    readonly options: (TransactionOptions | undefined)[] = [];
    private nextId = 0;

    constructor() { super(); }
    async beginTransaction(options?: TransactionOptions): Promise<MetadataWrappedTransaction<Tx>> {
        this.options.push(options);
        const id = ++this.nextId;
        this.events.push(`begin:${id}`);
        return { transaction: { id }, metadata: { driverName: "transactional-test" } };
    }
    async commitTransaction(tx: Tx): Promise<void> { this.events.push(`commit:${tx.id}`); }
    async rollbackTransaction(tx: Tx): Promise<void> { this.events.push(`rollback:${tx.id}`); }
    async createSavepoint(tx: Tx): Promise<void> { this.events.push(`savepoint:${tx.id}`); }
    async releaseSavepoint(tx: Tx): Promise<void> { this.events.push(`release:${tx.id}`); }
    async rollbackToSavepoint(tx: Tx): Promise<void> { this.events.push(`rollbackTo:${tx.id}`); }
}

const propagations = [Propagation.REQUIRED, Propagation.REQUIRES_NEW, Propagation.NESTED,
    Propagation.SUPPORTS, Propagation.NOT_SUPPORTED, Propagation.MANDATORY, Propagation.NEVER];

describe("transactional wrapper", () => {
    let manager: RecordingManager;
    const named = "transactional-test";
    const symbolic = Symbol("transactional-test");

    beforeEach(() => {
        manager = new RecordingManager();
        useTransactionManager(manager);
    });
    afterEach(() => {
        clearTransactionManager();
        clearTransactionManager(named);
        clearTransactionManager(symbolic);
        jest.restoreAllMocks();
    });

    it("is lazy, forwards this and every argument, and can be reused with different receivers", async () => {
        const calls: unknown[][] = [];
        const work = transactional(function(this: { prefix: string }, value: number, optional?: string, ...rest: boolean[]) {
            expect(manager.getCurrentTransaction()).toBeDefined();
            calls.push([this, value, optional, ...rest]);
            return `${this.prefix}:${value}:${optional}:${rest.join(",")}`;
        });
        expect(manager.events).toEqual([]);
        const first = { prefix: "first", work };
        const second = { prefix: "second", work };
        const result = first.work(7, "value", true, false);
        expect(result).toBeInstanceOf(Promise);
        await expect(result).resolves.toBe("first:7:value:true,false");
        await expect(second.work(8)).resolves.toBe("second:8:undefined:");
        expect(calls).toEqual([[first, 7, "value", true, false], [second, 8, undefined]]);
        expect(manager.events).toEqual(["begin:1", "commit:1", "begin:2", "commit:2"]);
    });

    it("unwraps async and thenable results while preserving returned object identity", async () => {
        const object = { value: 42 };
        await expect(transactional(async () => object)()).resolves.toBe(object);
        const thenable: PromiseLike<typeof object> = { then: (resolve, reject) => Promise.resolve(object).then(resolve, reject) };
        await expect(transactional(() => thenable)()).resolves.toBe(object);
        await expect(transactional(() => undefined)()).resolves.toBeUndefined();
    });

    it.each(propagations)("returns a Promise for synchronous work in ownerless %s", async propagation => {
        const body = jest.fn(() => 42);
        const work = transactional(body, { propagation });
        let result!: Promise<number>;
        expect(() => { result = work(); }).not.toThrow();
        expect(result).toBeInstanceOf(Promise);
        if (propagation === Propagation.MANDATORY) {
            await expect(result).rejects.toThrow(IllegalTransactionStateException);
            expect(body).not.toHaveBeenCalled();
        } else {
            await expect(result).resolves.toBe(42);
            expect(body).toHaveBeenCalledTimes(1);
        }
        const owns = [Propagation.REQUIRED, Propagation.REQUIRES_NEW, Propagation.NESTED].includes(propagation);
        expect(manager.events).toEqual(owns ? ["begin:1", "commit:1"] : []);
    });

    it.each(propagations)("preserves ambient semantics and synchronous results for %s", async propagation => {
        await transactional(async () => {
            const outer = manager.getCurrentTransaction();
            const body = jest.fn(() => {
                const current = manager.getCurrentTransaction();
                if (propagation === Propagation.NOT_SUPPORTED) expect(current).toBeUndefined();
                else if (propagation === Propagation.REQUIRES_NEW) expect(current).not.toBe(outer);
                else expect(current).toBe(outer);
                return 42;
            });
            const result = transactional(body, { propagation })();
            expect(result).toBeInstanceOf(Promise);
            if (propagation === Propagation.NEVER) {
                await expect(result).rejects.toThrow(IllegalTransactionStateException);
                expect(body).not.toHaveBeenCalled();
            } else {
                await expect(result).resolves.toBe(42);
                expect(body).toHaveBeenCalledTimes(1);
            }
            expect(manager.getCurrentTransaction()).toBe(outer);
        })();
        const middle = propagation === Propagation.NESTED ? ["savepoint:1", "release:1"]
            : propagation === Propagation.REQUIRES_NEW ? ["begin:2", "commit:2"] : [];
        expect(manager.events).toEqual(["begin:1", ...middle, "commit:1"]);
    });

    it.each(propagations)("accepts bare %s with the same behavior as a config object", async propagation => {
        const invoke = (argument: Propagation | TransactionConfig) => transactional(async () => {
            const outer = manager.getCurrentTransaction();
            const body = jest.fn(() => manager.getCurrentTransaction() === outer);
            const result = transactional(body, argument)();
            expect(result).toBeInstanceOf(Promise);
            if (propagation === Propagation.NEVER) {
                await expect(result).rejects.toThrow(IllegalTransactionStateException);
                expect(body).not.toHaveBeenCalled();
                return;
            }
            await expect(result).resolves.toBe(![Propagation.REQUIRES_NEW, Propagation.NOT_SUPPORTED].includes(propagation));
            expect(body).toHaveBeenCalledTimes(1);
        })();
        await invoke(propagation);
        const bareEvents = manager.events.map(event => event.replace(/:\d+$/, ":tx"));
        manager.events.length = 0;
        await invoke({ propagation });
        expect(manager.events.map(event => event.replace(/:\d+$/, ":tx"))).toEqual(bareEvents);
    });

    it("applies a bare ownerless MANDATORY propagation before the callback", async () => {
        const body = jest.fn();
        await expect(transactional(body, Propagation.MANDATORY)()).rejects.toThrow(IllegalTransactionStateException);
        expect(body).not.toHaveBeenCalled();
        expect(manager.events).toEqual([]);
    });

    it.each([undefined, named, symbolic])("resolves datasource %s at every invocation, not wrapper creation", async datasource => {
        clearTransactionManager(datasource);
        const work = transactional(() => 42, { datasource });
        await expect(work()).rejects.toThrow(DatasourceSetupError);
        useTransactionManager(manager, datasource);
        await expect(work()).resolves.toBe(42);
        const replacement = new RecordingManager();
        useTransactionManager(replacement, datasource);
        await expect(work()).resolves.toBe(42);
        expect(manager.events).toEqual(["begin:1", "commit:1"]);
        expect(replacement.events).toEqual(["begin:1", "commit:1"]);
        clearTransactionManager(datasource);
        await expect(work()).rejects.toThrow(DatasourceSetupError);
    });

    it("snapshots datasource, propagation and options without mutating caller config", async () => {
        useTransactionManager(manager, symbolic);
        const config: TransactionConfig = {
            datasource: symbolic, propagation: Propagation.REQUIRED, readOnly: true,
            isolationLevel: IsolationLevel.SERIALIZABLE, timeout: 1000,
        };
        const original = { ...config };
        const work = transactional(() => 42, config);
        expect(config).toEqual(original);
        Object.assign(config, { datasource: "missing", propagation: Propagation.MANDATORY,
            readOnly: false, isolationLevel: IsolationLevel.READ_COMMITTED, timeout: -1 });
        await expect(work()).resolves.toBe(42);
        await expect(work()).resolves.toBe(42);
        expect(manager.options).toEqual([
            { readOnly: true, isolationLevel: IsolationLevel.SERIALIZABLE, timeout: 1000 },
            { readOnly: true, isolationLevel: IsolationLevel.SERIALIZABLE, timeout: 1000 },
        ]);
        const frozen = Object.freeze({ readOnly: true });
        await expect(transactional(() => 7, frozen)()).resolves.toBe(7);
        expect(frozen).toEqual({ readOnly: true });
    });

    it("rejects synchronous application errors as Promises and rolls back", async () => {
        const failure = new Error("body failed");
        const work = transactional(() => { throw failure; });
        let result!: Promise<never>;
        expect(() => { result = work(); }).not.toThrow();
        expect(result).toBeInstanceOf(Promise);
        await expect(result).rejects.toBe(failure);
        expect(manager.events).toEqual(["begin:1", "rollback:1"]);
    });

    it("rejects setup, manager and invalid-option errors instead of throwing at invocation", async () => {
        const failure = new Error("manager failed");
        const body = jest.fn(() => 42);
        const missing = transactional(body, { datasource: "missing" });
        const invalid = transactional(body, { timeout: -1 });
        for (const work of [missing, invalid]) {
            let result!: Promise<number>;
            expect(() => { result = work(); }).not.toThrow();
            expect(result).toBeInstanceOf(Promise);
            await expect(result).rejects.toThrow();
        }
        jest.spyOn(manager, "executeTransaction").mockImplementation(() => { throw failure; });
        const work = transactional(body);
        let result!: Promise<number>;
        expect(() => { result = work(); }).not.toThrow();
        await expect(result).rejects.toBe(failure);
        expect(body).not.toHaveBeenCalled();
    });

    it("rolls back only a failed NESTED wrapper and permits the outer transaction to commit", async () => {
        const failure = new Error("nested failed");
        const nested = transactional(() => { throw failure; }, { propagation: Propagation.NESTED });
        await transactional(async () => {
            const outer = manager.getCurrentTransaction();
            await expect(nested()).rejects.toBe(failure);
            expect(manager.getCurrentTransaction()).toBe(outer);
        })();
        expect(manager.events).toEqual(["begin:1", "savepoint:1", "rollbackTo:1", "commit:1"]);
    });
});
