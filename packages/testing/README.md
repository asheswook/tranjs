# @tranjs/testing

Portable transaction sessions, restricted fixtures, probes, assertions, and Jest/Vitest matchers for TranJS.

## Install

```bash
npm install --save-dev @tranjs/testing@1.2.0
npm install @tranjs/core@1.2.0
```

`@tranjs/core@1.2.0` is a required exact peer. Jest 29/30 and Vitest 3/4/5 are optional runner peers; the base entry works with node:test, Mocha, or another runner without either. Compatible drivers are `@tranjs/pg@1.3.0`, `@tranjs/mysql2@1.3.0`, and `@tranjs/postgres@1.2.0` (postgres.js v3/v4).

## Real database sessions

Register the real driver manager once and apply schema migrations separately. Await all database work inside the callback.

```typescript
import { expect, test } from "@jest/globals";
import { transactional } from "@tranjs/core";
import { fixture, withTestTransaction } from "@tranjs/testing";
import type { PgFixtureConnection } from "@tranjs/pg";
import { ctx } from "@tranjs/pg";
import "@tranjs/testing/jest";

test("writes through a logical owner", async () => {
    await withTestTransaction(async tx => {
        await fixture(async (db: PgFixtureConnection) => {
            await db.query("INSERT INTO users(name) VALUES ($1)", ["Ada"]);
        });
        const read = tx.track(async () => {
            return (await ctx().query("SELECT name FROM users WHERE name = $1", ["Ada"])).rows;
        });
        expect(await transactional(read)()).toEqual([{ name: "Ada" }]);
        expect(read).toHaveCommitted();
    });
});
```

`withTestTransaction(fn, { datasource? }?)` rolls back awaited work routed through the selected manager. Owners use savepoints: "committed" means logical completion, not physical durability. The hidden transaction is not ambient; application SQL still needs `transactional` or `@Transactional`. `transactional(fn, config?)` returns a callable preserving dynamic `this` and arguments, always returning a Promise of the awaited result. It snapshots configuration at creation and resolves the manager at invocation.

`fixture(fn, options?)` supplies a restricted, revocable connection without changing ambient `ctx()` or `getCurrentTransaction()`. It requires a live integration session, not mock mode. Use only the matching type-only `PgFixtureConnection`, `Mysql2FixtureConnection`, or `PostgresFixtureConnection` export from the driver. pg supports `query(text, values?)`; mysql2 supports `query`/`execute` with native tuples; postgres.js supports tagged calls and `unsafe(text, values?)` returning plain Promises of row lists, not lazy query handles. Native connection controls, callback/config-object queries, streams and cursors are unavailable.

```typescript
import { fixture } from "@tranjs/testing";
import type { FixtureOptions } from "@tranjs/testing";
import type { PgFixtureConnection } from "@tranjs/pg";

export const pgFixture = <R>(fn: (ctx: PgFixtureConnection) => R, options?: FixtureOptions) => fixture(fn, options);
```

`FixtureOptions` is `{ datasource?: string | symbol }`. Annotations do not validate datasource wiring. Passing the fixture connection into application code is unsupported capability transfer.

Each fixture call uses one savepoint, no probe record, no logical TxState, and no deadline beyond native timeouts. All seven managed propagations on any datasource reject inside its callback. Recursive fixtures, fixtures from managed callbacks or commit/rollback hooks (including immediate ownerless `afterCommit` callbacks), and fixture/owner or fixture/fixture overlaps reject. Admission is synchronous before the first await. On callback completion the façade and escaped methods are revoked; pending queries fail and are drained. Session exit stops admission, settles admitted work, and retains pending-work misuse and cleanup errors.

SQL-error recovery rolls back to and releases the savepoint while preserving the original native error. Recovery failure poisons the session, preserves both failures, and makes final exit fail even if caught. This recovery differs from production. Returned data is not deeply scanned; not every missing await is detectable. Fixtures grant no implicit ambient capability and are not a SQL sandbox: COMMIT, DDL, sequences and external effects can escape rollback.

## Unit policy and assertions

`mockTransactions(async tx => …, { datasource? }?)` checks propagation, rollback-only policy, deadlines and hooks with no SQL. Real driver `ctx()` rejects in mock mode. `transactions()` returns the live session's probe and throws outside it.

- `tx.track(target)` observes call entry; call through the returned wrapper.
- `tx.txOf(fn, index = 0)` selects a recorded call's owner, or `undefined` for an outside call.
- `tx.transactions` is a read-only snapshot of logical owner records.
- `tx.fail("begin" | "commit" | "rollback", selector?)` injects owner-operation failures. Select with `containing` or `where`, not both; `times` defaults to one and `error` is optional. Begin failures cannot use `containing`. Timeout injection is not supported; use ordinary transaction `timeout`.

| Matcher | Portable assertion |
|---|---|
| `toRunInSameTransactionAs` | `assertSameTransaction` |
| `toRunInSeparateTransactionFrom` | `assertSeparateTransaction` |
| `toRunOutsideTransaction` | `assertOutsideTransaction` |
| `toRunAfterCommitOf` | `assertAfterCommitOf` |
| `toHaveCommitted` | `assertCommitted` |
| `toHaveRolledBack` | `assertRolledBack` |

Side-effect import `@tranjs/testing/jest` registers all six with `expect` from `@jest/globals` and supports `injectGlobals: false`. The ESM side-effect import `@tranjs/testing/vitest` registers them with Vitest's `expect`. Include imports in a test or a TypeScript-included runner setup file. Manual `expect.extend(matchers)` remains available with `matchers` from the base package. Portable assertions need no runner registration.

Operands must be tracked functions from one probe with exactly one recorded call each; misuse throws even under `.not`. Assertions observe entry, logical outcome and hook provenance, not SQL routing, awaited completion, physical durability or external delivery. `assertAfterCommitOf` requires observed hook provenance, not merely a later outside call.

## Limits and real commits

Raw connections, other datasources, detached work, runner hooks and external effects can escape rollback. Closed-session checks protect only work retaining its original context. Unbound timers or runner callbacks can join another session or open production transactions. Await and drain work before returning. Mock external effects: after-commit hooks run after logical completion, before physical rollback.

Within a session, `REQUIRES_NEW` uses the same physical connection; service isolation/read-only requests are recorded, not applied to savepoints. PostgreSQL deferred constraints are checked at owner and nested savepoint completion with their prior modes restored, but not every real COMMIT effect is exercised.

For durability, races, locks, or independent visibility, use no test session: migrate separately, seed/work through `transactional`, verify in a fresh independent transaction, and clean up in `finally` or use a disposable database. Concurrency tests require independent physical transactions outside sessions.

The core main entry loads no `@tranjs/testing`, probe, fake manager, matcher or runner code. No testing AsyncLocalStorage is allocated until a session starts; the internal bridge is inert without a session.

[Testing guide](https://github.com/asheswook/tranjs/blob/main/docs/testing.md): annotated examples for every driver and JavaScript, atomicity checks, tracking, failure selectors, cleanup and lifetime policies.
