import { Propagation, runInTransaction } from "@tranjs/core";
import {
    assertAfterCommitOf, assertCommitted, assertOutsideTransaction, assertRolledBack,
    assertSameTransaction, assertSeparateTransaction, matchers, mockTransactions,
    transactions as currentTransactions, TestTransactionInfo, TestTransactionProbe, withTestTransaction,
} from "@tranjs/testing";

// Compiled against the built package in Node10, Node16 and bundler resolution modes.
export const mockResult: Promise<{ value: number }> = mockTransactions(async t => {
    const repository = t.track({ save: (value: number) => ({ value }) });
    return runInTransaction(() => repository.save(42));
});
export const rollbackResult: Promise<number> = withTestTransaction(t => {
    const work = t.track((value: number) => value);
    return work(42);
});
export const namedMock: Promise<void> = mockTransactions(() => {}, { datasource: "testing" });
export const symbolMock: Promise<number> = mockTransactions(() => 42, { datasource: Symbol("testing") });
export const namedRollback: Promise<void> = withTestTransaction(async () => {}, { datasource: "testing" });
export const symbolRollback: Promise<number> = withTestTransaction(async () => 42, { datasource: Symbol("testing") });

export function consumeProbe(t: TestTransactionProbe): void {
    const current: TestTransactionProbe = currentTransactions();
    const work = t.track((value: number) => String(value));
    const other = t.track(() => {});
    assertSameTransaction(work, other);
    assertSeparateTransaction(work, other);
    assertOutsideTransaction(work);
    assertAfterCommitOf(work, other);
    assertCommitted(work);
    assertRolledBack(work);
    // @ts-expect-error Assertions require tracked function operands, not transaction records.
    assertCommitted({ outcome: "committed" });
    // @ts-expect-error Binary assertions require the second operand.
    assertSameTransaction(work);
    void current;
    void matchers.toHaveCommitted;
    const result: string = work(1);
    const tracked = t.track({ work, count: 1 });
    const trackedResult: string = tracked.work(tracked.count);
    const info: TestTransactionInfo | undefined = t.txOf(work);
    const later: TestTransactionInfo | undefined = t.txOf(tracked.work, 1);
    const transactions: readonly TestTransactionInfo[] = t.transactions;
    const datasource: string | symbol = t.datasource;
    t.fail("begin");
    t.fail("commit", { containing: work, times: 2, error: new Error("commit") });
    t.fail("rollback", { where: transaction => transaction.options.readOnly === true, error: "rollback" });
    if (info) {
        const outcome: "active" | "committed" | "rolled-back" = info.outcome;
        const parent: TestTransactionInfo | undefined = info.parent;
        const propagation: Propagation = info.propagation;
        void outcome;
        void parent;
        void propagation;
    }
    // @ts-expect-error Tracked call signatures are preserved.
    work("not a number");
    // @ts-expect-error Transaction collections are read-only.
    transactions.push(info!);
    // @ts-expect-error Savepoint injection is not public API.
    t.fail("savepoint");
    // @ts-expect-error Selectors receive transaction info, not a raw driver transaction.
    t.fail("commit", { where: (transaction: string) => transaction.length > 0 });
    void result;
    void trackedResult;
    void later;
    void datasource;
}

// Helpers control their transaction policy; only datasource is configurable.
// @ts-expect-error Propagation cannot be overridden on a test helper.
void withTestTransaction(() => {}, { propagation: Propagation.REQUIRED });
// @ts-expect-error Transaction options belong on application transaction boundaries.
void withTestTransaction(() => {}, { timeout: 1000 });
// @ts-expect-error Mock options only accept datasource.
void mockTransactions(() => {}, { readOnly: true });
// @ts-expect-error Datasource must be a string or symbol.
void mockTransactions(() => {}, { datasource: 42 });
