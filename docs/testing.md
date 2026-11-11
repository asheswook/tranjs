# Testing

## Choose what to use

| Situation | Helper |
|---|---|
| Real SQL, service atomicity, rollback isolation | [`withTestTransaction`](#real-database-isolation) |
| Propagation, hooks, failure policy without SQL | [`mockTransactions`](#unit-tests-without-sql) |
| Test-only DML in an integration session | [`withTestConnection`](#restricted-fixtures) |
| Assertions in Jest 29/30 or Vitest 3/4/5 | [Side-effect runner imports or manual registration](#six-matchers-and-portable-assertions) |
| Assertions in node:test, Mocha, or another runner | [Portable `assert*` functions](#six-matchers-and-portable-assertions) from `@tranjs/testing` |
| Durability, locks, races, independent transaction visibility | [Real commits and separate cleanup](#differences-from-production), without a test session |

`withTestTransaction` rolls back **awaited work routed through the selected manager**, via services, `transactional`, `@Transactional`, or `withTestConnection`. It does not contain raw connections, other datasources, detached work, external effects, or fixtures outside its callback.

## Key ideas

- **The hidden transaction is not ambient.** Application SQL needs `transactional` or `@Transactional`; `ctx()` alone is unavailable. `withTestConnection` supplies a restricted connection for test-only DML without changing ambient context. Keeping the hidden transaction non-ambient lets services own savepoints so atomicity remains observable.
- Await everything inside the callback, including timer work. Runner hooks and fixtures outside it need separate cleanup.
- "Committed" means the logical owner completed: its savepoint was released, not a durable physical commit. Cleanup attempts a physical rollback even when the test fails.
- Track dependencies inside the boundary, not the decorated service method: tracking observes function entry, before an outer decorator opens its transaction.
- Use one recorded call per matcher operand. For repeated calls, select explicit indexes with `txOf`.

## Real database isolation

Install `@tranjs/testing@1.2.0` separately with its required exact peer `@tranjs/core@1.2.0`. Compatible driver versions are `@tranjs/pg@1.3.0`, `@tranjs/mysql2@1.3.0`, and `@tranjs/postgres@1.2.0` (postgres.js v3 or v4). Jest and Vitest are optional peers. The base entry has no runner runtime requirement; runner entries register matchers and types, not lifecycle management.

The core main entry loads no `@tranjs/testing`, probe, fake manager, matcher or runner code. No testing AsyncLocalStorage is allocated until a session starts; the internal bridge is inert without a session. Drivers have no runtime dependency on `@tranjs/testing`.

The callback receives the probe as `tx`. `currentProbe()` returns that same probe and throws outside a live session; `currentProbe().records` is its record snapshot.

### Portable callback: real PostgreSQL with node:test

Apply schema migrations separately to a disposable PostgreSQL database, including `test_entries(batch text NOT NULL)`. Register the manager once; close the pool after all sessions finish.

```typescript
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { transactional } from "@tranjs/core";
import { withTestConnection, withTestTransaction } from "@tranjs/testing";
import type { TestConnection as PgTestConnection } from "@tranjs/pg";
import { ctx, usePostgreSQLTransactionManager } from "@tranjs/pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
usePostgreSQLTransactionManager(pool);

after(() => pool.end());

test("inserts without keeping the row", async () => {
    const batch = randomUUID();
    await withTestTransaction(async () => {
        await withTestConnection(async (db: PgTestConnection) => {
            await db.query("INSERT INTO test_entries(batch) VALUES ($1)", [batch]);
        });
        await transactional(async () => {
            const { rows } = await ctx().query(
                "SELECT batch FROM test_entries WHERE batch = $1", [batch],
            );
            assert.deepEqual(rows, [{ batch }]);
        })();
    });
    const { rows } = await transactional(() => ctx().query(
        "SELECT batch FROM test_entries WHERE batch = $1", [batch],
    ))();
    assert.deepEqual(rows, []);
});
```

The callback also works with Jest, Vitest, or Mocha. Independent sessions use separate connections: size the pool and isolate fixture IDs or schemas. Schema and shared data outside a session require separate cleanup.

Both `withTestTransaction(fn, options?)` and `mockTransactions(fn, options?)` return a Promise of the callback result. Their only option is `{ datasource?: string | symbol }`, selecting the default datasource when omitted. Pass `isolationLevel`, `readOnly`, and `timeout` to service scopes, not to these helpers.

### Jest 29 / 30: a small per-file helper

```typescript
import { expect, test } from "@jest/globals";
import { transactional } from "@tranjs/core";
import { currentProbe, withTestTransaction } from "@tranjs/testing";
import "@tranjs/testing/jest";
import { ctx } from "@tranjs/pg";

const it = (name: string, fn: Parameters<typeof withTestTransaction>[0]) =>
    test(name, () => withTestTransaction(fn));

// Register a real manager and create the users table in suite setup.
it("saves in a logical transaction", async () => {
    const save = currentProbe().track(async () => {
        await ctx().query("INSERT INTO users(name) VALUES ($1)", ["Ada"]);
    });
    await transactional(save)();
    expect(save).toHaveCommitted();
});
```

This wraps test bodies, not hooks. Imported Jest APIs work with `injectGlobals: false`; no TranJS test environment is needed.

### Vitest 3 / 4 / 5: a small per-file helper

Use the same helper with `expect` and `test` from `vitest`, and the ESM side-effect import `import "@tranjs/testing/vitest"`. It extends Vitest's `expect` automatically. Put rollback-sensitive setup, assertions, and teardown inside the callback; use `try` / `finally` for resources. Each retry opens a fresh session and awaits its cleanup.

## Restricted fixtures

```typescript
function withTestConnection<C, R>(fn: (db: C) => R, options?: TestOptions): Promise<Awaited<R>>;
// TestOptions: { datasource?: string | symbol }
```

Use `withTestConnection` only inside a live integration `withTestTransaction` session. It rejects calls outside a session, in a closed session, or in `mockTransactions`. Custom managers must support fixtures. It does not change what imported driver `ctx()` or `getCurrentTransaction()` returns.

Annotate callbacks with the matching restricted **type-only** driver export, not a native connection type. **Annotations do not validate datasource wiring.** Select the datasource with `TestOptions` and register its matching driver.

### pg

```typescript
import { withTestConnection } from "@tranjs/testing";
import type { TestOptions } from "@tranjs/testing";
import type { TestConnection as PgTestConnection } from "@tranjs/pg";

export const withPgTestConnection = <R>(fn: (db: PgTestConnection) => R, options?: TestOptions) => withTestConnection(fn, options);

// Inside withTestTransaction, with a registered pg manager:
await withPgTestConnection(async (db: PgTestConnection) => {
    const { rows } = await db.query("SELECT $1::text AS name", ["Ada"]);
    return rows[0];
});
```

`PgTestConnection` exposes only `query(text, values?)`, returning a Promise of the native `QueryResult`. Query config objects, callbacks, Submittables, cursors and streams are unavailable.

### mysql2

```typescript
import { withTestConnection } from "@tranjs/testing";
import type { TestConnection as Mysql2TestConnection } from "@tranjs/mysql2";

// Inside withTestTransaction, with a registered mysql2 manager:
await withTestConnection(async (db: Mysql2TestConnection) => {
    await db.execute("INSERT INTO users(name) VALUES (?)", ["Ada"]);
    const [rows, fields] = await db.query("SELECT name FROM users WHERE name = ?", ["Ada"]);
    return rows;
});
```

`Mysql2TestConnection` exposes only string-and-parameters `query` and `execute`, preserving native result tuples. Config objects and callbacks are unavailable.

### postgres.js v3 / v4

```typescript
import { withTestConnection } from "@tranjs/testing";
import type { TestConnection as PostgresTestConnection } from "@tranjs/postgres";

// Inside withTestTransaction, with a registered postgres.js manager:
await withTestConnection(async (db: PostgresTestConnection) => {
    await db`INSERT INTO users(name) VALUES (${"Ada"})`;
    return await db.unsafe("SELECT name FROM users WHERE name = $1", ["Ada"]);
});
```

Tagged calls and `unsafe(text, values?)` return plain Promises of native row lists. Lazy query objects are consumed internally and never exposed. No `execute`, `values`, `raw`, `describe`, cursor, stream, or SQL helpers are available.

### JavaScript

```javascript
import { withTestConnection } from "@tranjs/testing";

// Inside withTestTransaction, with a registered pg manager:
await withTestConnection(/** @param {import("@tranjs/pg").TestConnection} db */ async (db) => {
    await db.query("INSERT INTO users(name) VALUES ($1)", ["Ada"]);
});
```

### Fixture boundaries and recovery

- You cannot start transactions through TranJS inside a fixture callback, on **any datasource**. All seven propagation modes are rejected before their callbacks run. Do not nest fixtures or call them from transactional callbacks, `afterCommit`, or `afterRollback` hooks, including `afterCommit` callbacks that run immediately without a transaction. Fixtures do not make the hidden transaction available through driver `ctx()`.
- Run fixtures and transactional work sequentially. Overlapping calls are rejected as soon as they start, even before the first await.
- Each fixture call creates one savepoint and awaits the callback's returned value. The connection and its methods stop working when the callback finishes. Queries still pending at that point fail the fixture call; it waits for them to finish before releasing the savepoint. Await every query.
- SQL errors recover with `ROLLBACK TO` and `RELEASE`, preserving the original native error, such as `23505` or `ER_DUP_ENTRY`. If recovery fails, the session cannot continue safely: both errors are preserved, and session cleanup fails even if you catch the fixture error. **This savepoint recovery differs from production SQL-error handling.**
- When the session ends, it rejects new fixture calls and waits for existing calls to finish. Unfinished fixture work is an error; rollback and release errors are preserved alongside earlier errors. Always await transactional work too.
- A fixture does not create a service transaction or add a transaction to the probe. TranJS timeouts do not apply; database timeouts still do. Keep the connection and its methods inside the callback. Returned data is not checked for nested connection references, and not every missing await is detectable.

**Do not pass this connection into application code.** Fixtures are not a SQL sandbox: explicit COMMIT/ROLLBACK, DDL (including implicit MySQL commits), sequences, and external effects can escape rollback. Apply schema migrations separately; use fixtures for controlled test-only DML.

### Deferred callbacks and runner hooks

**Callbacks do not contain detached work.** Flush fake timers and await their work before returning. Helpers cannot intercept or rebind arbitrary registrations. On Node.js, Jest 29/30 and Vitest 3/4/5 behave as follows:

| Mechanism | Invocation after callback A closes | Transaction behavior |
|---|---|---|
| Native Promise continuation registered in A | Promise resolved inside B or in `afterAll` | Retains closed A; core transaction entry rejects before SQL, rather than joining B or opening a production transaction |
| Unbound fake timer registered in A | Flushed inside callback B | Adopts B's session and connection; B's rollback undoes the writes, not A's |
| Unbound fake timer registered in A | Flushed in `afterAll`, without a session | Opens a physical production transaction; committed writes persist and are visible from another connection |
| Unbound Vitest `onTestFinished` registered inside A | Runner invokes it after A | Runs without A's session; a transactional service can physically commit persistent writes; unsupported for isolated database work |
| Jest `afterEach` registered before the test, calling an unbound function assigned inside A | Runner invokes it after A | Runs without A's session; a transactional service can physically commit persistent writes |
| Jest `afterEach` registered inside A | Registration during the test | Jest rejects nested hook registration; the hook is not installed |
| Completion callback explicitly captured with native `AsyncLocalStorage.bind` inside A | Invoked after A closes | Retains closed A; core transaction entry rejects before SQL |

Registering `onTestFinished` inside a helper does not bind it. Closed-session checks cannot protect work that lost its context. The same rules apply to `mockTransactions`: unbound late work can reach the restored real manager and persist writes.

If registration is unavoidable and Node.js provides `AsyncLocalStorage.bind`, bind while the owner is live. This guards against late entry; it does not permit late SQL:

```typescript
import { AsyncLocalStorage } from "node:async_hooks";
import { expect, onTestFinished, test } from "vitest";
import { transactional } from "@tranjs/core";
import { withTestTransaction } from "@tranjs/testing";
import { ctx } from "@tranjs/pg";

// Register a real manager and create the users table in suite setup.
test("rejects transaction entry from a bound completion callback", async () => {
    await withTestTransaction(async () => {
        onTestFinished(AsyncLocalStorage.bind(async () => {
            await expect(transactional(async () => {
                // This SQL must not run: the captured session is already closed.
                await ctx().query("INSERT INTO users(name) VALUES ($1)", ["Ada"]);
            })()).rejects.toThrow();
        }));
        // Await all intended database work here, before returning.
    });
});
```

For preregistered Jest hooks, bind the actual deferred function inside the callback. Prefer completing work inside the helper.

### NestJS services

Resolve services through Nest's testing module normally. TranJS needs no Nest-specific context transport. Track injected repository calls inside the service boundary, rather than wrapping the decorated service method itself.

```typescript
import { Inject, Injectable } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { expect, test } from "vitest";
import { Transactional } from "@tranjs/core";
import { assertCommitted, withTestTransaction } from "@tranjs/testing";
import { ctx } from "@tranjs/pg";

@Injectable()
class UsersRepository {
    async save(name: string) {
        await ctx().query("INSERT INTO users(name) VALUES ($1)", [name]);
    }
}

@Injectable()
class UsersService {
    constructor(@Inject(UsersRepository) private readonly users: UsersRepository) {}

    @Transactional()
    async create(name: string) {
        await this.users.save(name);
    }
}

// Register a real manager and create the users table in suite setup.
test("creates through Nest dependency injection", async () => {
    await withTestTransaction(async tx => {
        const users = tx.track(new UsersRepository());
        const module = await Test.createTestingModule({
            providers: [UsersService, { provide: UsersRepository, useValue: users }],
        }).compile();
        try {
            await module.get(UsersService).create("Ada");
            assertCommitted(users.save);
            expect(tx.records).toHaveLength(1);
        } finally {
            await module.close();
        }
    });
});
```

Close the module inside the callback, and close shared database pools only after all callbacks using them finish.

## Commit and rollback outcomes

Final cleanup alone cannot prove service atomicity. A failed owner rolls back its savepoint immediately; a successful owner releases it, leaving writes visible to later scopes on this connection until final cleanup.

```typescript
import { expect, test } from "vitest";
import { transactional } from "@tranjs/core";
import {
    assertCommitted, assertRolledBack, withTestTransaction,
} from "@tranjs/testing";
import { ctx } from "@tranjs/pg";

// Use a registered real manager and a users table created in suite setup.
test("failure removes partial writes; success keeps them until cleanup", async () => {
    await withTestTransaction(async tx => {
        const failedSave = tx.track(async () => {
            await ctx().query("INSERT INTO users(name) VALUES ($1)", ["failed"]);
        });
        const successfulSave = tx.track(async () => {
            await ctx().query("INSERT INTO users(name) VALUES ($1)", ["saved"]);
        });
        const read = transactional(async () => {
            const { rows } = await ctx().query(
                "SELECT name FROM users WHERE name IN ('failed', 'saved') ORDER BY name",
            );
            return rows;
        });

        await expect(transactional(async () => {
            await failedSave();
            throw new Error("second step failed");
        })()).rejects.toThrow("second step failed");
        assertRolledBack(failedSave);
        expect(await read()).toEqual([]);

        await transactional(successfulSave)();
        assertCommitted(successfulSave);
        expect(await read()).toEqual([{ name: "saved" }]);
    });
});
```

`"committed"` means **logical owner completion**, not durable physical commit. Joined failures still mark the owner rollback-only; catching one can produce `UnexpectedRollbackError`. `NESTED` shares its owner's record but can roll back its own savepoint.

PostgreSQL drivers check deferred constraints before owner and `NESTED` savepoint commits. A temporary check savepoint runs `SET CONSTRAINTS ALL IMMEDIATE`, then rolls back and releases, restoring the **exact prior modes**. Violations retain native error classes/codes (such as `23505`) and roll back that scope. Earlier pending violations on the shared connection can surface here. This does not exercise every real COMMIT effect.

## After-commit effects

`afterCommit` runs after successful logical owner completion, **before final physical rollback**. Mock email, HTTP, file, and cache effects because database rollback cannot undo them. Assert callback provenance, not just that an outside call happened later.

```typescript
import { expect, test, vi } from "vitest";
import { afterCommit, transactional } from "@tranjs/core";
import { mockTransactions } from "@tranjs/testing";
import "@tranjs/testing/vitest";

test("publishes after this transaction commits", async () => {
    await mockTransactions(async tx => {
        const save = tx.track(vi.fn(async () => {}));
        const audit = tx.track(vi.fn(async () => {}));
        const publish = tx.track(vi.fn());
        await transactional(async () => {
            await save();
            await audit();
            afterCommit(publish);
            expect(publish).not.toHaveBeenCalled();
        })();
        expect(save).toHaveCommitted();
        expect(save).toRunInSameTransactionAs(audit);
        expect(publish).toRunOutsideTransaction();
        expect(publish).toRunAfterCommitOf(save);
    });
});
```

Use `withTestTransaction` for the same policy with real SQL. `toRunAfterCommitOf` requires an observed `afterCommit` callback associated with that committed transaction; an ordinary later call outside a transaction does not qualify. Hooks registered in `NESTED` belong to the owner; `REQUIRES_NEW` owns its own hooks. Successful hook assertions prove ordering and provenance, not durable delivery.

## Boundaries and failure handling

### Unit tests without SQL

`mockTransactions` exercises TranJS propagation, rollback-only rules, deadlines, and hooks with mocked transaction operations. It does not validate SQL, database isolation, or physical commits. Real driver `ctx()` calls under it throw `TransactionContextMixingError`; mock data access instead.

### Six matchers and portable assertions

`import "@tranjs/testing/jest"` registers all six matchers using `expect` from `@jest/globals`, including with `injectGlobals: false`. The ESM import `import "@tranjs/testing/vitest"` registers them with Vitest's `expect`. These entries also provide matcher type augmentation; Jest supports both the Jest namespace and the `expect` module. No runner environment or lifecycle adapter is needed.

Manual registration remains available: import `{ matchers }` from `@tranjs/testing` and call `expect.extend(matchers)`. The base entry also exports throwing assertion functions for `node:test`, Mocha, or any other assertion library.

#### Registering matchers for all tests

List the package entry in runner config; no setup file or matcher import in individual tests is needed. Jest 29/30 accept the bare entry with `injectGlobals` either true or false:

```javascript
// jest.config.cjs
module.exports = {
    setupFilesAfterEnv: ["@tranjs/testing/jest"],
};
```

Runner config does not load TypeScript augmentation. In `tsconfig.json`, add the matcher entry to `types`, keeping your project's other type entries:

```json
{
    "compilerOptions": {
        "types": ["node", "jest", "@tranjs/testing/jest"],
        "skipLibCheck": false
    }
}
```

For Vitest 3, resolve the entry to a file path in config. This form also works with Vitest 4/5 and requires Node 18.19+ or 20.6+:

```javascript
// vitest.config.mjs
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        setupFiles: [fileURLToPath(import.meta.resolve("@tranjs/testing/vitest"))],
    },
});
```

Vitest 4/5 also accept `setupFiles: ["@tranjs/testing/vitest"]` directly. Load its TypeScript augmentation in `tsconfig.json`:

```json
{
    "compilerOptions": {
        "types": ["node", "@tranjs/testing/vitest"],
        "skipLibCheck": false
    }
}
```

When runner globals are disabled, import `expect` and `test` from the runner as usual. As a per-file alternative to config registration, import `"@tranjs/testing/jest"` or `"@tranjs/testing/vitest"` in each test; that import loads both registration and types for the file.

| Jest / Vitest matcher | Assertion from `@tranjs/testing` | Meaning |
|---|---|---|
| `expect(a).toRunInSameTransactionAs(b)` | `assertSameTransaction(a, b)` | Both calls entered the same transaction owner |
| `expect(a).toRunInSeparateTransactionFrom(b)` | `assertSeparateTransaction(a, b)` | Both entered transactions, with different owners |
| `expect(a).toRunOutsideTransaction()` | `assertOutsideTransaction(a)` | Call entered without an active logical transaction |
| `expect(a).toRunAfterCommitOf(b)` | `assertAfterCommitOf(a, b)` | Call ran through an observed after-commit callback of b's committed owner |
| `expect(a).toHaveCommitted()` | `assertCommitted(a)` | Call's owner completed successfully |
| `expect(a).toHaveRolledBack()` | `assertRolledBack(a)` | Call's owner rolled back |

> **What the assertions prove and don't prove**
>
> They prove which transaction a tracked call **entered** (same/separate/outside), its owner's logical outcome, and whether it ran through an `afterCommit` callback.
>
> They do **not** prove that tracked async work completed before commit (missing await), that SQL used the managed connection (raw-connection escapes), physical commit/durability, or delivery of external effects.
>
> **Practical checks:** after the callback, query test-specific rows in a fresh independent transaction and assert none remain, as in the PostgreSQL example. Drain queued work first: an early query cannot detect future writes. Not every missing await is detectable; use a lint rule such as `@typescript-eslint/no-floating-promises` as well.

Operands must be tracked functions from the same probe, with **exactly one recorded call each**. Untracked functions, zero/multiple calls, and cross-session operands are usage errors even under `.not`. Two outside calls are neither same nor separate transactions. Await owner completion for outcome assertions.

Failures report calls, transaction identities, propagation, and outcomes, without deciding whether code or test should change. Portable assertions throw without runner setup.

### Tracking and records

`track<T>(target: T): T` preserves the public type. **Call through the returned wrapper** and use it for assertions and failure selectors. Tracking observes context at function entry; it does not open a transaction. Track repository calls inside the service, not an outer decorated method that has yet to open its boundary.

Object tracking creates a fresh wrapper, supports frozen objects, and invokes methods and getters with the original object as receiver, including `#private` access. Standalone functions preserve explicit call-site `this`. Jest/Vi fluent mock configuration stays on the tracked wrapper. Calls through original references and internal `this.otherMethod()` calls are not intercepted; tracking does not instrument prototypes or other instances. Retain function-valued getter results when you need to identify their calls.

`txOf(fn, call = 0)` returns the `TestTransactionInfo` at entry to a zero-based tracked call, or `undefined` for a recorded outside call. Untracked functions and nonexistent indexes throw.

| `TestTransactionInfo` field | Meaning |
|---|---|
| `id` | Boundary identity within this probe |
| `outcome` | `"active"`, `"committed"`, or `"rolled-back"` |
| `options` | Frozen requested `isolationLevel`, `readOnly`, and `timeout` |
| `parent` | Active logical transaction when this owner opened, or `undefined` |
| `propagation` | Propagation that opened the owner, not a later joined call |

Joined `REQUIRED`, `MANDATORY`, and `SUPPORTS` calls share the owner record, as does `NESTED`. Outcome matchers describe that owner, not whether an individual `NESTED` savepoint rolled back. `REQUIRES_NEW` gets a distinct record even on the same physical test connection. `parent` is not the last record created: a boundary inside `NOT_SUPPORTED` has no active logical parent.

`tx.records` is a read-only snapshot of owner records, including failed begins as `"rolled-back"`. Joined calls and ordinary savepoints add no records. `tx.datasource` identifies the selected datasource. Mock outcomes describe TranJS policy, not database writes.

### Inject failures at a chosen boundary

Both helpers support `tx.failNext("begin" | "commit" | "rollback", selector?)`. Register failures before the matching operation. These target owner operations, not arbitrary SQL or savepoint-operation failures.

```typescript
import { expect, test, vi } from "vitest";
import { afterCommit, afterRollback, transactional } from "@tranjs/core";
import { assertRolledBack, mockTransactions } from "@tranjs/testing";

test("does not publish when commit fails", async () => {
    await mockTransactions(async tx => {
        const save = tx.track(vi.fn(async () => {}));
        const publish = vi.fn();
        const rollback = vi.fn();
        const error = new Error("connection lost");
        tx.failNext("commit", { containing: save, times: 1, error });

        await expect(transactional(async () => {
            await save();
            afterCommit(publish);
            afterRollback(rollback);
        })()).rejects.toBe(error);
        assertRolledBack(save);
        expect(publish).not.toHaveBeenCalled();
        expect(rollback).toHaveBeenCalledTimes(1);
    });
});
```

| Selector | Meaning |
|---|---|
| `containing?: Function` | Select an owner containing a call to this tracked function |
| `where?: (info: TestTransactionInfo) => boolean` | Select by owner info instead of call order |
| `times?: number` | Positive number of matching operations to fail; defaults to one |
| `error?: unknown` | Value to throw; omit for a generated error |

Omit the selector to fail the next matching operation. Do not combine `containing` and `where`. Begin failures cannot use `containing`: the call has not run. Use `tx.failNext("begin")` or select with `where`. Failed begins have records but no callback calls.

### Timeouts

Targeted timeout injection (choosing which transaction times out) is **not provided**; `tx.failNext` accepts only begin, commit, and rollback. Test deadlines with the ordinary transaction `timeout` option:

```typescript
import { expect, test } from "@jest/globals";
import { transactional, TransactionTimeoutError } from "@tranjs/core";
import { mockTransactions } from "@tranjs/testing";

test("rejects when the owner exceeds its deadline", async () => {
    await mockTransactions(async () => {
        await expect(transactional(async () => {
            await new Promise(resolve => setTimeout(resolve, 50));
        }, { timeout: 10 })()).rejects.toBeInstanceOf(TransactionTimeoutError);
    });
});
```

Use real timers and await the work. The same option works in service scopes under `withTestTransaction`; neither helper itself accepts `timeout`. Deadlines cannot select an interior failure point, interrupt arbitrary I/O, or guarantee server cancellation.

### Errors and recovery

| Failure | Result / action |
|---|---|
| Cleanup after application failure | `TransactionSystemError.applicationError` retains the application failure; `cause` retains cleanup failure |
| Caught PostgreSQL SQL error leaves owner aborted | Savepoint completion recovers, runs rollback hooks, and rejects: `@tranjs/pg` uses `TestTransactionAbortedError` (`25P02`); `@tranjs/postgres` uses `TransactionAbortedError` |
| Recovery fails | Session is poisoned; stop opening scopes. Callback `finally` still runs for ordinary resource cleanup |
| Recovery and final physical rollback both fail | Outer `cause` = physical rollback error; outer `applicationError` = recovery `TransactionSystemError`, whose `cause` = recovery error and `applicationError` = original failure |
| Final cleanup fails | Reset the database; do not assume isolation held |

## Differences from production

| Behavior | Production | `withTestTransaction` |
|---|---|---|
| Physical transactions | Owners open real transactions | One hidden transaction; owners use savepoints; final physical rollback |
| `ctx()` outside a scope | No active transactional context | Also unavailable; use `transactional` or the fixture connection for test-only SQL |
| `REQUIRED`, `MANDATORY`, `SUPPORTS` | Normal joining and absence rules | Same logical rules; the hidden transaction is not ambient |
| `NESTED` | Savepoint sharing owner state, hooks, and deadline | Same sharing; no separate owner record |
| `REQUIRES_NEW` | Independent transaction, visibility, and durability | Separate logical owner on the **same connection**; sees parent writes and is undone by enclosing rollback |
| Commit hooks | After physical commit | After owner savepoint success, before final rollback; external effects remain |
| Service `isolationLevel` / `readOnly` | Applied to a new physical transaction | Recorded, **not applied** to inner owners/savepoints |
| Timeouts | Owner deadlines and driver query checks | Logical deadlines/query checks remain; not universal server cancellation or a hard completion guarantee |
| Deferred PostgreSQL constraints | Checked according to their modes, including at real COMMIT | Checked at owner and `NESTED` savepoint completion, restoring exact prior modes; not all COMMIT effects |
| Injected commit/rollback failures | Physical failures may leave uncertain outcomes | Savepoint recovery contains writes; does not reproduce uncertain physical COMMIT outcomes |

Use tests with **real commits, independent physical transactions, and separate cleanup** for races, locking, isolation levels, independent `REQUIRES_NEW` visibility/durability, commit-time behavior beyond the deferred-constraint check, and actual driver/network failures. No test session means no testing behavior: production transactions retain their normal lifecycle.

### Real commits without a session

Apply schema migrations separately. Do not use `withTestTransaction` or `mockTransactions` in these tests. Seed fixtures and run application work through `transactional`, verify through a fresh independent transaction, and clean up in `finally` or use a disposable database.

```typescript
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { transactional } from "@tranjs/core";
import { ctx } from "@tranjs/pg";

// Register the manager once; migrate test_entries(batch text NOT NULL) separately.
const batch = randomUUID();
try {
    await transactional(async () => {
        await ctx().query("INSERT INTO test_entries(batch) VALUES ($1)", [batch]);
    })();
    // Invoke application work here, outside any test session.
    const { rows } = await transactional(() => ctx().query(
        "SELECT batch FROM test_entries WHERE batch = $1", [batch],
    ))(); // A fresh transaction, independent of the completed write transaction.
    assert.deepEqual(rows, [{ batch }]);
} finally {
    await transactional(async () => {
        await ctx().query("DELETE FROM test_entries WHERE batch = $1", [batch]);
    })();
}
```

Concurrency tests must open independent physical transactions outside test sessions, with enough connections and separate cleanup. Concurrent sessions are an isolation convenience, not a substitute for physical transaction visibility or locking tests.

### Concurrency and lifetime

- Run sibling owners, `NESTED` branches, and fixtures sequentially inside one real session. Savepoints share a connection and form a stack; overlapping scopes are rejected. Do not use `Promise.all` for sibling transaction branches or fixtures.
- Independent concurrent real callbacks can use the same manager with separate connections.
- Nested `withTestTransaction` calls are rejected, even across datasources; use separate top-level callbacks.
- Concurrent or nested `mockTransactions` calls on the same datasource are rejected. Mocking temporarily replaces its registration: do not run real work against that datasource concurrently. Workers need independent registrations.
- Await all work inside its owning callback, including work started by fake timers. Closed-session checks only protect work that retains that session's context; they cannot bind arbitrary deferred callbacks to their owner. Do not re-register a manager while another test is using it.

### What rollback cannot contain

- Raw connection access, other datasources, and independently executed `NOT_SUPPORTED` work escape the selected test transaction and can persist writes. Probe assertions cannot detect whether application SQL used a raw connection instead of the managed one.
- Runner hooks are outside the callback's lifetime. Service calls from suite hooks can open real transactions and commit; callbacks registered in one test but invoked in another can join the invoking test's session. Neither case is contained by the registering test's rollback.
- Explicit `COMMIT` / `ROLLBACK` can invalidate containment. MySQL DDL can implicitly commit, destroy savepoints, and leave writes behind. Use separate setup, teardown, and cleanup for these tests.
- Sequences, emails, HTTP calls, files, caches, and mock state are not reset by database rollback. Mock external effects or clean them up separately.

These helpers isolate transactional DML routed through the selected manager; they do not guarantee that arbitrary SQL or effects cannot persist.
