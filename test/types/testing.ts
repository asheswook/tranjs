import { Propagation, transactional } from "@tranjs/core";
import {
    assertAfterCommitOf, assertCommitted, assertOutsideTransaction, assertRolledBack,
    assertSameTransaction, assertSeparateTransaction, fixture, FixtureOptions, matchers, mockTransactions,
    transactions as currentTransactions, TestTransactionInfo, TestTransactionProbe, withTestTransaction,
} from "@tranjs/testing";
import type { PgFixtureConnection } from "@tranjs/pg";
import type { Mysql2FixtureConnection } from "@tranjs/mysql2";
import type { PostgresFixtureConnection } from "@tranjs/postgres";

// Compiled against the built package in Node10, Node16 and bundler resolution modes.
export const mockResult: Promise<{ value: number }> = mockTransactions(async t => {
    const repository = t.track({ save: (value: number) => ({ value }) });
    return transactional(() => repository.save(42))();
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

// Fixture callback annotations select the driver facade; options can be forwarded.
void fixture(connection => {
    // @ts-expect-error An unannotated fixture context is unknown, never an unrestricted native client.
    return connection.query("SELECT 1");
});
export function forwardingFixture<C, R>(fn: (connection: C) => R, options: FixtureOptions): Promise<Awaited<R>> {
    return fixture(fn, options);
}
export const pgFixture = fixture((connection: PgFixtureConnection) => {
    const result = connection.query<{ value: number }>("SELECT $1 AS value", [42]);
    // @ts-expect-error Configuration objects and callbacks are not fixture query forms.
    connection.query({ text: "SELECT 1" });
    // @ts-expect-error Native callback overloads are excluded.
    connection.query("SELECT 1", [], () => {});
    // @ts-expect-error Native connection internals cannot escape the facade.
    void connection.connection;
    // @ts-expect-error TranJS owns the connection lifecycle.
    connection.release();
    return result;
}, { datasource: "pg" });
export const mysqlFixture = fixture((connection: Mysql2FixtureConnection) => {
    const result = connection.execute("SELECT ? AS value", [42]);
    void connection.query("SELECT 1");
    // @ts-expect-error Native config-object overloads are excluded.
    connection.execute({ sql: "SELECT 1" });
    // @ts-expect-error Native callback overloads are excluded.
    connection.query("SELECT 1", [], () => {});
    // @ts-expect-error Native connection internals cannot escape the facade.
    void connection.connection;
    // @ts-expect-error Manual lifecycle operations are excluded.
    connection.commit();
    return result;
}, { datasource: Symbol("mysql") });
export const postgresFixture = fixture((connection: PostgresFixtureConnection) => {
    const result: Promise<unknown> = connection`SELECT ${42} AS value`;
    void connection.unsafe<{ value: number }[]>("SELECT $1 AS value", [42]);
    // @ts-expect-error Config objects are not SQL text.
    connection.unsafe({ text: "SELECT 1" });
    // @ts-expect-error Native unsafe query options are excluded.
    connection.unsafe("SELECT 1", [], { simple: true });
    // @ts-expect-error Fixture tags return plain eager promises, not native pending queries.
    connection`SELECT 1`.cursor(1);
    // @ts-expect-error Identifier helpers are not part of the restricted fixture facade.
    connection("items");
    // @ts-expect-error Native lifecycle methods cannot escape the facade.
    connection.reserve();
    // @ts-expect-error Native configuration cannot escape the facade.
    void connection.options;
    return result;
});
// @ts-expect-error Fixtures accept datasource only, not transaction policy.
void fixture((connection: PgFixtureConnection) => connection.query("SELECT 1"), { propagation: Propagation.REQUIRED });
// @ts-expect-error Fixtures do not expose transaction configuration.
void fixture((connection: PgFixtureConnection) => connection.query("SELECT 1"), { readOnly: true });
// @ts-expect-error Datasource forwarding remains type checked.
void fixture((connection: PgFixtureConnection) => connection.query("SELECT 1"), { datasource: 42 });
