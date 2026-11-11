import { Propagation, transactional } from "@tranjs/core";
import {
    assertAfterCommitOf, assertCommitted, assertOutsideTransaction, assertRolledBack,
    assertSameTransaction, assertSeparateTransaction, withTestConnection, TestOptions, matchers, mockTransactions,
    currentProbe, TestTransactionRecord, TestTransactionProbe, withTestTransaction,
} from "@tranjs/testing";
import type { TestConnection as PgTestConnection } from "@tranjs/pg";
import type { TestConnection as Mysql2TestConnection } from "@tranjs/mysql2";
import type { TestConnection as PostgresTestConnection } from "@tranjs/postgres";

// Compiled against the built package in Node10, Node16 and bundler resolution modes.
export const mockResult: Promise<{ value: number }> = mockTransactions(async tx => {
    const repository = tx.track({ save: (value: number) => ({ value }) });
    return transactional(() => repository.save(42))();
});
export const rollbackResult: Promise<number> = withTestTransaction(tx => {
    const work = tx.track((value: number) => value);
    return work(42);
});
export const namedMock: Promise<void> = mockTransactions(() => {}, { datasource: "testing" });
export const symbolMock: Promise<number> = mockTransactions(() => 42, { datasource: Symbol("testing") });
export const namedRollback: Promise<void> = withTestTransaction(async () => {}, { datasource: "testing" });
export const symbolRollback: Promise<number> = withTestTransaction(async () => 42, { datasource: Symbol("testing") });
export const defaultTestOptions: TestOptions = {};
export const namedTestOptions: TestOptions = { datasource: "testing" };
export const symbolTestOptions: TestOptions = { datasource: Symbol("testing") };
export const optionsMock: Promise<number> = mockTransactions(() => 42, namedTestOptions);
export const optionsRollback: Promise<number> = withTestTransaction(() => 42, symbolTestOptions);
export const defaultTestConnection: Promise<number> = withTestConnection(async (db: PgTestConnection) => {
    await db.query("SELECT 1");
    return 42;
}, defaultTestOptions);
export const namedDefaultTestConnection: Promise<number> = withTestTransaction(() =>
    withTestConnection(async (db: PgTestConnection) => {
        await db.query("SELECT 1");
        return 42;
    }), namedTestOptions);
export const symbolDefaultTestConnection: Promise<number> = withTestTransaction(() =>
    withTestConnection(async (db: PgTestConnection) => {
        await db.query("SELECT 1");
        return 42;
    }), symbolTestOptions);

export function consumeProbe(tx: TestTransactionProbe): void {
    const current: TestTransactionProbe = currentProbe();
    const work = tx.track((value: number) => String(value));
    const other = tx.track(() => {});
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
    const tracked = tx.track({ work, count: 1 });
    const trackedResult: string = tracked.work(tracked.count);
    const info: TestTransactionRecord | undefined = tx.txOf(work);
    const later: TestTransactionRecord | undefined = tx.txOf(tracked.work, 1);
    const records: readonly TestTransactionRecord[] = tx.records;
    const datasource: string | symbol = tx.datasource;
    tx.failNext("begin");
    tx.failNext("commit", { containing: work, times: 2, error: new Error("commit") });
    tx.failNext("rollback", { where: transaction => transaction.options.readOnly === true, error: "rollback" });
    if (info) {
        const outcome: "active" | "committed" | "rolled-back" = info.outcome;
        const parent: TestTransactionRecord | undefined = info.parent;
        const propagation: Propagation = info.propagation;
        void outcome;
        void parent;
        void propagation;
    }
    // @ts-expect-error Tracked call signatures are preserved.
    work("not a number");
    // @ts-expect-error Transaction collections are read-only.
    records.push(info!);
    // @ts-expect-error Savepoint injection is not public API.
    tx.failNext("savepoint");
    // @ts-expect-error Selectors receive transaction info, not a raw driver transaction.
    tx.failNext("commit", { where: (transaction: string) => transaction.length > 0 });
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

// Fixture callback annotations select the driver facade; options can be forwarded.
void withTestConnection(db => {
    // @ts-expect-error An unannotated fixture context is unknown, never an unrestricted native client.
    return db.query("SELECT 1");
});
export function forwardingTestConnection<C, R>(fn: (db: C) => R, options: TestOptions): Promise<Awaited<R>> {
    return withTestConnection(fn, options);
}
export const pgTestConnection = withTestConnection((db: PgTestConnection) => {
    const result = db.query<{ value: number }>("SELECT $1 AS value", [42]);
    // @ts-expect-error Configuration objects and callbacks are not fixture query forms.
    db.query({ text: "SELECT 1" });
    // @ts-expect-error Native callback overloads are excluded.
    db.query("SELECT 1", [], () => {});
    // @ts-expect-error Native connection internals cannot escape the facade.
    void db.connection;
    // @ts-expect-error TranJS owns the connection lifecycle.
    db.release();
    return result;
}, { datasource: "pg" });
export const mysqlTestConnection = withTestConnection((db: Mysql2TestConnection) => {
    const result = db.execute("SELECT ? AS value", [42]);
    void db.query("SELECT 1");
    // @ts-expect-error Native config-object overloads are excluded.
    db.execute({ sql: "SELECT 1" });
    // @ts-expect-error Native callback overloads are excluded.
    db.query("SELECT 1", [], () => {});
    // @ts-expect-error Native connection internals cannot escape the facade.
    void db.connection;
    // @ts-expect-error Manual lifecycle operations are excluded.
    db.commit();
    return result;
}, { datasource: Symbol("mysql") });
export const postgresTestConnection = withTestConnection((db: PostgresTestConnection) => {
    const result: Promise<unknown> = db`SELECT ${42} AS value`;
    void db.unsafe<{ value: number }[]>("SELECT $1 AS value", [42]);
    // @ts-expect-error Config objects are not SQL text.
    db.unsafe({ text: "SELECT 1" });
    // @ts-expect-error Native unsafe query options are excluded.
    db.unsafe("SELECT 1", [], { simple: true });
    // @ts-expect-error Fixture tags return plain eager promises, not native pending queries.
    db`SELECT 1`.cursor(1);
    // @ts-expect-error Identifier helpers are not part of the restricted fixture facade.
    db("items");
    // @ts-expect-error Native lifecycle methods cannot escape the facade.
    db.reserve();
    // @ts-expect-error Native configuration cannot escape the facade.
    void db.options;
    return result;
});
// @ts-expect-error Fixtures accept datasource only, not transaction policy.
void withTestConnection((db: PgTestConnection) => db.query("SELECT 1"), { propagation: Propagation.REQUIRED });
// @ts-expect-error Fixtures do not expose transaction configuration.
void withTestConnection((db: PgTestConnection) => db.query("SELECT 1"), { readOnly: true });
// @ts-expect-error Datasource forwarding remains type checked.
void withTestConnection((db: PgTestConnection) => db.query("SELECT 1"), { datasource: 42 });
