import { AsyncLocal, TxState } from "../src/asyncLocal";
import { MetadataWrappedTransaction } from "../src/context";
import {
    NestedTransactionNotSupportedError, TransactionContextMixingError,
    TransactionTimeoutError, UnexpectedRollbackError,
} from "../src/error";
import { DefaultLogger } from "../src/logger";
import { PlatformTransactionManager } from "../src/manager";
import { Propagation } from "../src/propagation";

interface Tx { id: string }

class CoverageManager extends PlatformTransactionManager<Tx> {
    readonly events: string[] = [];

    constructor() { super(); }

    expire() { return this.expireTransaction(); }

    protected async beginTransaction(): Promise<MetadataWrappedTransaction<Tx>> {
        return { transaction: { id: "coverage" }, metadata: { driverName: "coverage" } };
    }

    protected async commitTransaction(): Promise<void> { this.events.push("commit"); }
    protected async rollbackTransaction(): Promise<void> { this.events.push("rollback"); }

    public createSavepoint(tx: Tx, name: string): Promise<void> {
        return super.createSavepoint(tx, name);
    }

    public rollbackToSavepoint(tx: Tx, name: string): Promise<void> {
        return super.rollbackToSavepoint(tx, name);
    }

    public releaseSavepoint(tx: Tx, name: string): Promise<void> {
        return super.releaseSavepoint(tx, name);
    }
}

function state(id: string, active: boolean): TxState {
    return {
        context: { transaction: { id }, metadata: { driverName: "coverage" } },
        active, rollbackOnly: false, savepointCounter: 0, afterCommit: [], afterRollback: [],
    };
}

describe("core coverage gaps", () => {
    afterEach(() => jest.restoreAllMocks());

    it.each([
        ["info", "log"], ["warn", "warn"], ["error", "error"], ["debug", "debug"],
    ] as const)("DefaultLogger.%s forwards the message and arguments to console.%s", (level, method) => {
        const output = jest.spyOn(console, method).mockImplementation(() => {});
        const detail = { transaction: 1 };
        new DefaultLogger()[level]("message", detail, 42);
        expect(output).toHaveBeenCalledTimes(1);
        expect(output).toHaveBeenCalledWith("message", detail, 42);
    });

    it("falls back from a completed current context to the latest active manager", () => {
        const first = state("first", true);
        const latest = state("latest", true);
        const completed = state("completed", false);
        const txs = new Map<PlatformTransactionManager<any>, TxState | null>([
            [new CoverageManager(), first],
            [new CoverageManager(), latest],
            [new CoverageManager(), completed],
            [new CoverageManager(), null],
        ]);
        AsyncLocal.RunFrame({ txs, current: completed.context }, () => {
            expect(AsyncLocal.Context).toBe(latest.context);
            latest.active = false;
            expect(AsyncLocal.Context).toBe(first.context);
            first.active = false;
            expect(AsyncLocal.Context).toBeUndefined();
        });
        expect(AsyncLocal.Frame).toBeUndefined();
    });

    it("does not expire a missing transaction or one without a deadline", async () => {
        const manager = new CoverageManager();
        expect(manager.expire()).toBeUndefined();
        await manager.executeTransaction(Propagation.REQUIRED, () => {
            expect(manager.expire()).toBeUndefined();
            expect(AsyncLocal.Frame!.txs.get(manager)!.rollbackOnly).toBe(false);
        });
        expect(manager.events).toEqual(["commit"]);
        expect(manager.expire()).toBeUndefined();
    });

    it("marks a deadline transaction rollback-only even when a query timer fires early", async () => {
        jest.spyOn(Date, "now").mockReturnValue(1000);
        const manager = new CoverageManager();
        await expect(manager.executeTransaction(Propagation.REQUIRED, () => {
            const transaction = AsyncLocal.Frame!.txs.get(manager)!;
            expect(transaction.deadline).toBe(1050);
            const error = manager.expire();
            expect(error).toBeInstanceOf(TransactionTimeoutError);
            expect(error).toMatchObject({ name: "TransactionTimeoutError", message: "Transaction timed out after 50ms" });
            expect(transaction.rollbackOnly).toBe(true);
        }, { timeout: 50 })).rejects.toThrow(UnexpectedRollbackError);
        expect(manager.events).toEqual(["rollback"]);
    });

    it.each(["createSavepoint", "rollbackToSavepoint", "releaseSavepoint"] as const)(
        "the default %s hook rejects unsupported nested transactions", async method => {
            const manager = new CoverageManager();
            await expect(manager[method]({ id: "legacy" }, "savepoint"))
                .rejects.toThrow(NestedTransactionNotSupportedError);
            expect(manager.events).toEqual([]);
        },
    );

    it.each([
        ["pg", "mysql2"],
        [Symbol("pg"), Symbol("mysql2")],
    ])("describes mixed transaction drivers %s and %s", (current, requested) => {
        const error = new TransactionContextMixingError(current, requested);
        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe("TransactionContextMixingError");
        expect(error.message).toBe(
            `Transaction context mixing error: Current active context driver is '${current.toString()}', but tried to use ctx() of '${requested.toString()}'.`,
        );
    });
});
