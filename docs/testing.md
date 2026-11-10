# Testing

## 1. Isolate integration tests against a real database

Use `withTestTransaction` from `@tranjs/core/testing` to run real SQL and roll back the test's writes afterward. It opens one hidden physical transaction on the registered manager. Service transaction owners use savepoints on that connection, and cleanup always attempts a physical rollback, even when the test fails.

The hidden transaction is **not an ambient service transaction**. Call services normally; wrap direct SQL, including assertion queries, in `runInTransaction` or `@Transactional`. Outside a logical scope, `ctx()` is unavailable.

### Choose an entry point

Use an explicit `withTestTransaction` callback for every isolated real-database test, whether using Jest 29 / 30, Vitest 3 / 4 / 5, `node:test`, or Mocha. The base `@tranjs/core/testing` entry has **no Jest or Vitest runtime requirement**. Runner packages are optional peers: install only the runner you use. The Jest and Vitest entries export only `matchers` and matcher type augmentation; they do not manage test lifecycles.

The callback receives a probe as `tx`; `transactions()` from `@tranjs/core/testing` retrieves that same probe from the current test session and throws outside a live session. It is not a global fallback or a list of records; `transactions().transactions` is the record snapshot.

### Portable callback: real PostgreSQL with node:test

Install `@tranjs/core`, `@tranjs/pg`, and `pg`. Point `DATABASE_URL` at a disposable PostgreSQL database, for example:

```sh
docker run --rm --name tranjs-test-postgres \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=tranjs_test \
  -p 5433:5432 -d postgres:16
export DATABASE_URL=postgres://postgres:postgres@localhost:5433/tranjs_test
```

```typescript
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { runInTransaction } from "@tranjs/core";
import { withTestTransaction } from "@tranjs/core/testing";
import { ctx, usePostgreSQLTransactionManager } from "@tranjs/pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
usePostgreSQLTransactionManager(pool);

before(async () => {
    await pool.query("CREATE TABLE test_entries (batch text NOT NULL)");
});
after(async () => {
    try {
        await pool.query("DROP TABLE test_entries");
    } finally {
        await pool.end();
    }
});

test("inserts without keeping the row", async () => {
    const batch = randomUUID();
    await withTestTransaction(async () => {
        await runInTransaction(async () => {
            await ctx().query("INSERT INTO test_entries(batch) VALUES ($1)", [batch]);
        });
        await runInTransaction(async () => {
            const { rows } = await ctx().query(
                "SELECT batch FROM test_entries WHERE batch = $1", [batch],
            );
            assert.deepEqual(rows, [{ batch }]);
        });
    });
    const { rows } = await pool.query(
        "SELECT batch FROM test_entries WHERE batch = $1", [batch],
    );
    assert.deepEqual(rows, []);
});
```

The callback works unchanged with Jest, Vitest, or Mocha test functions. Independent concurrent callbacks use separate physical connections; size the pool accordingly and isolate fixture identifiers or worker schemas. Keep rollback-sensitive fixtures inside the callback and a logical transaction scope. Create schema and shared fixtures outside it and remove them in teardown.

Both `withTestTransaction(fn, options?)` and `mockTransactions(fn, options?)` return a Promise of the callback result. Their only option is `{ datasource?: string | symbol }`, selecting the default datasource when omitted. Pass `isolationLevel`, `readOnly`, and `timeout` to service scopes, not to these helpers.

### Jest 29 / 30: a small per-file helper

```typescript
import { expect, test } from "@jest/globals";
import { runInTransaction } from "@tranjs/core";
import { transactions, withTestTransaction } from "@tranjs/core/testing";
import { matchers } from "@tranjs/core/testing/jest";
import { ctx } from "@tranjs/pg";

expect.extend(matchers);
const it = (name, fn) => test(name, () => withTestTransaction(fn));

// Register a real manager and create the users table in suite setup.
it("saves in a logical transaction", async () => {
    const save = transactions().track(async () => {
        await ctx().query("INSERT INTO users(name) VALUES ($1)", ["Ada"]);
    });
    await runInTransaction(save);
    expect(save).toHaveCommitted();
});
```

The local helper explicitly wraps each test body, not runner hooks. Imported Jest APIs work with `injectGlobals: false`; no TranJS test environment is needed. Add parameter types to the helper when using TypeScript's `noImplicitAny`.

### Vitest 3 / 4 / 5: a small per-file helper

```typescript
import { expect, test } from "vitest";
import { runInTransaction } from "@tranjs/core";
import { transactions, withTestTransaction } from "@tranjs/core/testing";
import { matchers } from "@tranjs/core/testing/vitest";
import { ctx } from "@tranjs/pg";

expect.extend(matchers);
const it = (name, fn) => test(name, () => withTestTransaction(fn));

// Register a real manager and create the users table in suite setup.
it("saves in a logical transaction", async () => {
    const save = transactions().track(async () => {
        await ctx().query("INSERT INTO users(name) VALUES ($1)", ["Ada"]);
    });
    await runInTransaction(save);
    expect(save).toHaveCommitted();
});
```

No runner hook configuration is required. Put rollback-sensitive setup, assertions, and teardown inside the helper callback, using `try` / `finally` for resource cleanup. A retry that invokes the test body again opens a new callback session. Each callback awaits its own final cleanup; runner hooks and runner-managed fixtures that execute outside the callback are not part of that session.

### Deferred callbacks and runner hooks

**Warning: callbacks are not a detached-work containment boundary.** Every isolated test must await all its work inside the owning callback. Flush fake timers and await the work they start before that callback returns. Runner-managed fixtures outside the callback are not isolated by it; arrange separate cleanup for suite fixtures.

`withTestTransaction` cannot intercept or rebind arbitrary callback registration. Native asynchronous resources often retain the registering AsyncLocalStorage context, but fake-clock callbacks and runner hooks use their invocation context. The following rules apply to Jest 29 / 30 and Vitest 3 / 4 / 5 on Node.js, with the same behavior across the listed majors of each applicable runner:

| Mechanism | Invocation after callback A closes | Transaction behavior |
|---|---|---|
| Native Promise continuation registered in A | Promise resolved inside B or in `afterAll` | Retains closed A; core transaction entry rejects before SQL, rather than joining B or opening a production transaction |
| Unbound fake timer registered in A | Flushed inside callback B | Adopts B's session and connection; B's rollback undoes the writes, not A's |
| Unbound fake timer registered in A | Flushed in `afterAll`, without a session | Opens a physical production transaction; committed writes persist and are visible from another connection |
| Unbound Vitest `onTestFinished` registered inside A | Runner invokes it after A | Runs without A's session; a transactional service can physically commit persistent writes; unsupported for isolated database work |
| Jest `afterEach` registered before the test, calling an unbound function assigned inside A | Runner invokes it after A | Runs without A's session; a transactional service can physically commit persistent writes |
| Jest `afterEach` registered inside A | Registration during the test | Jest rejects nested hook registration; the hook is not installed |
| Completion callback explicitly captured with native `AsyncLocalStorage.bind` inside A | Invoked after A closes | Retains closed A; core transaction entry rejects before SQL |

Unbound completion callbacks are unsafe for isolated database work. In particular, registering Vitest `onTestFinished` inside the helper does not bind it to that helper. Do not defer database work to runner hooks or flush callbacks outside their owner. Closed-session checks cannot protect callbacks that have lost that session's context, and there is no runner interception to restore it.

The same lifetime rules apply to `mockTransactions`. Native Promise work retaining its closed mock session rejects even after the original manager registration is restored. Unbound late work that loses that context can use the restored real manager and commit database writes.

If deferred registration is unavoidable on a Node.js version providing `AsyncLocalStorage.bind`, explicitly bind the callback while its owner is live to obtain a clear rejection after closure. This is a defensive guard, not permission to run SQL after the helper. For example, this Vitest completion callback asserts the rejection rather than performing teardown SQL:

```typescript
import { AsyncLocalStorage } from "node:async_hooks";
import { expect, onTestFinished, test } from "vitest";
import { runInTransaction } from "@tranjs/core";
import { withTestTransaction } from "@tranjs/core/testing";
import { ctx } from "@tranjs/pg";

// Register a real manager and create the users table in suite setup.
test("rejects transaction entry from a bound completion callback", async () => {
    await withTestTransaction(async () => {
        onTestFinished(AsyncLocalStorage.bind(async () => {
            await expect(runInTransaction(async () => {
                // This SQL must not run: the captured session is already closed.
                await ctx().query("INSERT INTO users(name) VALUES ($1)", ["Ada"]);
            })).rejects.toThrow();
        }));
        // Await all intended database work here, before returning.
    });
});
```

The same native binding captures the owner for a Jest callback assigned inside the helper and invoked by a preregistered hook. Bind the actual deferred function inside the callback, not the runner hook outside it. Prefer completing all work inside the helper instead.

### NestJS services

Resolve services through Nest's testing module normally. TranJS needs no Nest-specific context transport. Track injected repository calls inside the service boundary, rather than wrapping the decorated service method itself.

```typescript
import { Inject, Injectable } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { expect, test } from "vitest";
import { Transactional } from "@tranjs/core";
import { assertCommitted, withTestTransaction } from "@tranjs/core/testing";
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
            expect(tx.transactions).toHaveLength(1);
        } finally {
            await module.close();
        }
    });
});
```

Close the module inside the callback, and close shared database pools only after all callbacks using them finish.

## 2. Check commit and rollback outcomes inside the test

Final cleanup alone cannot prove service atomicity. A failed owner rolls back its savepoint immediately; a successful owner releases it, leaving writes visible to later scopes on this connection until final cleanup.

```typescript
import { expect, test } from "vitest";
import { runInTransaction } from "@tranjs/core";
import {
    assertCommitted, assertRolledBack, withTestTransaction,
} from "@tranjs/core/testing";
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
        const read = () => runInTransaction(async () => {
            const { rows } = await ctx().query(
                "SELECT name FROM users WHERE name IN ('failed', 'saved') ORDER BY name",
            );
            return rows;
        });

        await expect(runInTransaction(async () => {
            await failedSave();
            throw new Error("second step failed");
        })).rejects.toThrow("second step failed");
        assertRolledBack(failedSave);
        expect(await read()).toEqual([]);

        await runInTransaction(successfulSave);
        assertCommitted(successfulSave);
        expect(await read()).toEqual([{ name: "saved" }]);
    });
});
```

`"committed"` means **logical owner completion**, not durable physical commit. Joined failures still mark the owner rollback-only; catching one can produce `UnexpectedRollbackError`. `NESTED` shares its owner's record but can roll back its own savepoint.

For PostgreSQL, the native driver hook checks deferred constraints before logical owner and `NESTED` savepoint commits. It stashes the current constraint modes using a temporary check savepoint, executes `SET CONSTRAINTS ALL IMMEDIATE`, then rolls back to and releases that check savepoint. This restores the **exact previous modes**, including initially immediate constraints and application `SET CONSTRAINTS` choices; setting everything deferred afterward would be incorrect. Violations keep the native driver's error class and code, such as `23505`, and roll back the affected scope. The check can encounter pending violations from earlier work on the shared connection. It does not exercise every effect of a real COMMIT.

## 3. Check after-commit effects

`afterCommit` runs after successful logical owner completion, **before final physical rollback**. Mock email, HTTP, file, and cache effects because database rollback cannot undo them. Assert callback provenance, not just that an outside call happened later.

```typescript
import { expect, test, vi } from "vitest";
import { afterCommit, runInTransaction } from "@tranjs/core";
import { mockTransactions } from "@tranjs/core/testing";
import { matchers } from "@tranjs/core/testing/vitest";

expect.extend(matchers);

test("publishes after this transaction commits", async () => {
    await mockTransactions(async tx => {
        const save = tx.track(vi.fn(async () => {}));
        const publish = tx.track(vi.fn());
        await runInTransaction(async () => {
            await save();
            afterCommit(publish);
            expect(publish).not.toHaveBeenCalled();
        });
        expect(save).toHaveCommitted();
        expect(publish).toRunOutsideTransaction();
        expect(publish).toRunAfterCommitOf(save);
    });
});
```

Use `withTestTransaction` for the same policy with real SQL. `toRunAfterCommitOf` requires an observed `afterCommit` callback associated with that committed transaction; an ordinary later call outside a transaction does not qualify. Hooks registered in `NESTED` belong to the owner; `REQUIRES_NEW` owns its own hooks. Successful hook assertions prove ordering and provenance, not durable delivery.

## 4. Check TranJS boundaries and failure handling

### Unit tests without SQL

`mockTransactions` exercises TranJS propagation, rollback-only rules, deadlines, and hooks with mocked transaction operations. It does not validate SQL, database isolation, or physical commits. Real driver `ctx()` calls under it throw `TransactionContextMixingError`; mock data access instead.

```typescript
import { expect, jest, test } from "@jest/globals";
import { Transactional } from "@tranjs/core";
import { mockTransactions } from "@tranjs/core/testing";
import { matchers } from "@tranjs/core/testing/jest";

expect.extend(matchers);

class TransferService {
    constructor(private readonly accounts: {
        debit: () => Promise<void>;
        credit: () => Promise<void>;
    }) {}

    @Transactional()
    async transfer() {
        await this.accounts.debit();
        await this.accounts.credit();
    }
}

test("debit and credit share the committed owner", async () => {
    await mockTransactions(async tx => {
        const accounts = tx.track({
            debit: jest.fn(async () => {}),
            credit: jest.fn(async () => {}),
        });
        await new TransferService(accounts).transfer();
        expect(accounts.debit).toRunInSameTransactionAs(accounts.credit);
        expect(accounts.debit).toHaveCommitted();
    });
});
```

The runner entries provide matchers and type augmentation only. Keep each isolated test inside an explicit real or mock callback.

### Six matchers and portable assertions

Use `expect.extend(matchers)` with `matchers` from the Jest or Vitest entry. The base entry exports throwing assertion functions for `node:test`, Mocha, or any other assertion library.

| Jest / Vitest matcher | Assertion from `@tranjs/core/testing` | Meaning |
|---|---|---|
| `expect(a).toRunInSameTransactionAs(b)` | `assertSameTransaction(a, b)` | Both calls entered the same transaction owner |
| `expect(a).toRunInSeparateTransactionFrom(b)` | `assertSeparateTransaction(a, b)` | Both entered transactions, with different owners |
| `expect(a).toRunOutsideTransaction()` | `assertOutsideTransaction(a)` | Call entered without an active logical transaction |
| `expect(a).toRunAfterCommitOf(b)` | `assertAfterCommitOf(a, b)` | Call ran through an observed after-commit callback of b's committed owner |
| `expect(a).toHaveCommitted()` | `assertCommitted(a)` | Call's owner completed successfully |
| `expect(a).toHaveRolledBack()` | `assertRolledBack(a)` | Call's owner rolled back |

Operands must be tracked functions with **exactly one recorded call each**, from the same probe. Untracked functions, zero or multiple calls, and cross-session operands are usage errors, including under `.not`; they never silently pass. Two outside calls are neither the same transaction nor separate transactions. Await owner completion before checking outcomes. For repeated calls, inspect explicit indexes with `txOf` rather than relying on these matchers to choose one.

Assertion failures identify the calls, transaction identities, propagation, and outcomes. Jest and Vitest entries include matcher type augmentation. The portable functions throw on assertion failure without needing runner setup:

```typescript
import { assertSameTransaction, mockTransactions } from "@tranjs/core/testing";
import { runInTransaction } from "@tranjs/core";

await mockTransactions(async tx => {
    const debit = tx.track(async () => {});
    const credit = tx.track(async () => {});
    await runInTransaction(async () => {
        await debit();
        await credit();
    });
    assertSameTransaction(debit, credit);
});
```

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

`tx.transactions` is a read-only snapshot of owner records, including failed begins as `"rolled-back"`. Joined calls and ordinary savepoints add no records. `tx.datasource` identifies the selected datasource. Mock outcomes describe TranJS policy, not database writes.

### Inject failures at a chosen boundary

Both helpers support `tx.fail("begin" | "commit" | "rollback", selector?)`. Register failures before the matching operation. These target owner operations, not arbitrary SQL or savepoint-operation failures.

```typescript
import { expect, test, vi } from "vitest";
import { afterCommit, afterRollback, runInTransaction } from "@tranjs/core";
import { assertRolledBack, mockTransactions } from "@tranjs/core/testing";

test("does not publish when commit fails", async () => {
    await mockTransactions(async tx => {
        const save = tx.track(vi.fn(async () => {}));
        const publish = vi.fn();
        const rollback = vi.fn();
        const error = new Error("connection lost");
        tx.fail("commit", { containing: save, times: 1, error });

        await expect(runInTransaction(async () => {
            await save();
            afterCommit(publish);
            afterRollback(rollback);
        })).rejects.toBe(error);
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

Omit the selector to fail the next matching operation. Do not combine `containing` and `where`. A begin failure cannot use `containing`, because the call has not run: use `tx.fail("begin")` or `tx.fail("begin", { where: info => info.options.readOnly === true })`. Failed begins have records but no callback calls.

Cleanup failures must not hide application failures. `TransactionSystemError` preserves the application error in `applicationError` and the cleanup error in `cause`. A caught PostgreSQL query error can leave an owner aborted; failed savepoint completion recovers that scope, runs rollback hooks, and rejects. `@tranjs/pg` reports `TestTransactionAbortedError` with code `25P02`; `@tranjs/postgres` uses `TransactionAbortedError`. Failed recovery poisons the test session: stop starting transaction scopes in it. User callback `finally` blocks still run regardless of session readiness; keep ordinary resource cleanup there. If recovery and final physical rollback both fail, the outer `TransactionSystemError.cause` is the physical rollback error, and its `applicationError` retains the recovery `TransactionSystemError`; that inner error's `cause` is the recovery failure and its `applicationError` is the original application failure. If final cleanup fails, reset the database rather than assuming isolation held.

## 5. Differences from production and when real commits are required

| Behavior | Production | `withTestTransaction` |
|---|---|---|
| Physical transactions | Owners open real transactions | One hidden transaction; owners use savepoints; final physical rollback |
| `ctx()` outside a scope | No active transactional context | Also unavailable; assertion queries need a logical scope |
| `REQUIRED`, `MANDATORY`, `SUPPORTS` | Normal joining and absence rules | Same logical rules; the hidden transaction is not ambient |
| `NESTED` | Savepoint sharing owner state, hooks, and deadline | Same sharing; no separate owner record |
| `REQUIRES_NEW` | Independent transaction, visibility, and durability | Separate logical owner on the **same connection**; sees parent writes and is undone by enclosing rollback |
| Commit hooks | After physical commit | After owner savepoint success, before final rollback; external effects remain |
| Service `isolationLevel` / `readOnly` | Applied to a new physical transaction | Recorded, **not applied** to inner owners/savepoints |
| Timeouts | Owner deadlines and driver query checks | Logical deadlines/query checks remain; not universal server cancellation or a hard completion guarantee |
| Deferred PostgreSQL constraints | Checked according to their modes, including at real COMMIT | Checked at owner and `NESTED` savepoint completion, restoring exact prior modes; not all COMMIT effects |
| Injected commit/rollback failures | Physical failures may leave uncertain outcomes | Savepoint recovery contains writes; does not reproduce uncertain physical COMMIT outcomes |

Use tests with **real commits, independent physical transactions, and separate cleanup** for races, locking, isolation levels, independent `REQUIRES_NEW` visibility/durability, commit-time behavior beyond the deferred-constraint check, and actual driver/network failures. No test session means no testing behavior: production transactions retain their normal lifecycle.

### Concurrency and lifetime

- Run sibling owners and `NESTED` branches sequentially inside one real session. Savepoints share a connection and form a stack; overlapping scopes are rejected. Do not use `Promise.all` for sibling transaction branches.
- Independent concurrent real callbacks can use the same manager with separate connections.
- Nested `withTestTransaction` calls are rejected, even across datasources; use separate top-level callbacks.
- Concurrent or nested `mockTransactions` calls on the same datasource are rejected. Mocking temporarily replaces its registration: do not run real work against that datasource concurrently. Workers need independent registrations.
- Await all work inside its owning callback, including work started by fake timers. Closed-session checks only protect work that retains that session's context; they cannot bind arbitrary deferred callbacks to their owner. Do not re-register a manager while another test is using it.

### What rollback cannot contain

- Raw pool/connection queries, other datasources, and independently executed `NOT_SUPPORTED` work escape the selected test transaction and can persist writes.
- Runner hooks are outside the callback's lifetime. Service calls from suite hooks can open real transactions and commit; callbacks registered in one test but invoked in another can join the invoking test's session. Neither case is contained by the registering test's rollback.
- Explicit `COMMIT` / `ROLLBACK` can invalidate containment. MySQL DDL can implicitly commit, destroy savepoints, and leave writes behind. Use separate setup, teardown, and cleanup for these tests.
- Sequences, emails, HTTP calls, files, caches, and mock state are not reset by database rollback. Mock external effects or clean them up separately.

These helpers isolate transactional DML routed through the selected manager; they do not guarantee that arbitrary SQL or effects cannot persist.
