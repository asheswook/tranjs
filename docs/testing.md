# Testing

`@tranjs/testing` lets you run a service against a real database and roll back its changes after the test. You can also check which calls share a transaction, or test transaction handling with mocked repositories and no database. It works with any runner; we test it with Jest, Vitest and node:test.

Add the testing package to a project that already uses TranJS and a driver:

```sh
npm install --save-dev @tranjs/testing
```

## First test

Pass the objects returned by `tx.track(...)` to the service you are testing. These wrappers record calls; the original objects keep working as before, but calls through them are not recorded.

This service saves a user and an audit entry in one transaction. The [setup below](#setup) registers PostgreSQL and creates its tables.

```typescript
// users.test.ts (Jest)
import { expect, test } from "@jest/globals";
import { transactional } from "@tranjs/core";
import { ctx } from "@tranjs/pg";
import { withTestTransaction } from "@tranjs/testing";

const usersRepo = { save: (name: string) => ctx().query("INSERT INTO docs_users VALUES ($1)", [name]) };
const auditRepo = { record: (name: string) => ctx().query("INSERT INTO docs_audit VALUES ($1)", [name]) };
function userService(users: typeof usersRepo, audit: typeof auditRepo) {
    return { create: transactional(async (name: string) => {
        await users.save(name);
        await audit.record(name);
    }) };
}

test("saves the user and audit entry together", () => withTestTransaction(async tx => {
    const users = tx.track(usersRepo);
    const audit = tx.track(auditRepo);
    const service = userService(users, audit);
    await service.create("Ada");
    expect(users.save).toRunInSameTransactionAs(audit.record);
}));
```

`transactional(fn)` creates a function; calling that function starts the transaction. Here, `service.create("Ada")` makes that call.

## Setup

Use a separate database for tests. Run your schema migrations before the tests start. The examples in this guide use these two tables:

```sql
CREATE TABLE docs_users (name text NOT NULL);
CREATE TABLE docs_audit (name text NOT NULL);
```

Register a manager in each test file's setup and close its pool after that file's tests finish. For Jest, load this setup file through `setupFilesAfterEnv`. For Vitest, change the hook import to `vitest` and load it through `setupFiles`.

```typescript
// test/database.ts
import { afterAll, beforeAll } from "@jest/globals";
import { Pool } from "pg";
import { usePostgreSQLTransactionManager } from "@tranjs/pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
beforeAll(() => { usePostgreSQLTransactionManager(pool); });
afterAll(() => pool.end());
```

Each running test holds one connection until its callback and cleanup finish. When test files run in parallel, allow enough connections across all workers' pools and the database's connection limit. Keep data prepared outside the callback separate from data that another test may change.

### Register matchers

Use `setupFilesAfterEnv: ["@tranjs/testing/jest"]` for Jest, or `setupFiles: ["@tranjs/testing/vitest"]` for Vitest. Include your database setup file in the same list:

```javascript
// jest.config.cjs
module.exports = {
    setupFilesAfterEnv: ["@tranjs/testing/jest", "<rootDir>/test/database.ts"],
};
```

```javascript
// vitest.config.mjs
import { defineConfig } from "vitest/config";
export default defineConfig({
    test: { setupFiles: ["@tranjs/testing/vitest", "./test/database.ts"] },
});
```

If Vitest cannot resolve the bare package name in your workspace layout, replace that entry with a resolved file path:

```javascript
// vitest.config.mjs (fallback)
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
    test: { setupFiles: [
        fileURLToPath(import.meta.resolve("@tranjs/testing/vitest")),
        "./test/database.ts",
    ] },
});
```

For TypeScript, add the matcher entry to your existing `types` list. Use this for Jest:

```json
{ "compilerOptions": { "types": ["node", "jest", "@tranjs/testing/jest"] } }
```

For Vitest:

```json
{ "compilerOptions": { "types": ["node", "@tranjs/testing/vitest"] } }
```

Use your runner's TypeScript transform to run `.ts` test and setup files.

As a per-file alternative, import `"@tranjs/testing/jest"` or `"@tranjs/testing/vitest"` in each test file. This registers the matchers and loads their types for that file. Import `expect` and `test` from your runner when its globals are disabled. You can also register the exported `matchers` yourself with `expect.extend(matchers)`.

## Seeding and reading data

Use `withTestConnection` for setup and checks inside `withTestTransaction`. Its `db` argument gives you a small set of SQL methods. Annotate it with the matching driver's `TestConnection` type; choose the matching registered datasource too, since the annotation only checks TypeScript types.

```typescript
// seed.test.ts (Jest, using the setup above)
import { expect, test } from "@jest/globals";
import type { TestConnection } from "@tranjs/pg";
import { withTestConnection, withTestTransaction } from "@tranjs/testing";
import type { TestOptions } from "@tranjs/testing";

const withPgTestConnection = <R>(fn: (db: TestConnection) => R, options?: TestOptions) => withTestConnection(fn, options);

test("reads the data prepared for this test", () => withTestTransaction(async () => {
    await withPgTestConnection(async db => {
        await db.query("INSERT INTO docs_users VALUES ($1)", ["Ada"]);
    });
    const names = await withPgTestConnection(async db => {
        const { rows } = await db.query("SELECT name FROM docs_users ORDER BY name");
        return rows.map(row => row.name);
    });
    expect(names).toEqual(["Ada"]);
}));
```

The other drivers export their own `TestConnection`. For example, these callbacks insert the same data:

```typescript
import type { TestConnection as MysqlConnection } from "@tranjs/mysql2";
import type { TestConnection as PostgresConnection } from "@tranjs/postgres";

export const seedMysql = (db: MysqlConnection) => db.execute("INSERT INTO docs_users VALUES (?)", ["Ada"]);
export const seedPostgres = (db: PostgresConnection) => db`INSERT INTO docs_users VALUES (${"Ada"})`;
```

| Driver | Methods on `db` | Result |
|---|---|---|
| pg | `query(text, values?)` | A Promise of the driver's `QueryResult` |
| mysql2 | `query(text, values?)`, `execute(text, values?)` | A Promise of the driver's `[rows, fields]` pair |
| postgres.js | Tagged SQL and `unsafe(text, values?)` | A plain Promise of the driver's row list |

These methods take SQL text and parameters, rather than query config objects or callback arguments. Connection controls, streams, cursors and driver query modifiers are outside this interface.

In JavaScript, use JSDoc for the callback type:

```javascript
import { withTestConnection } from "@tranjs/testing";

export const seedAda = () => withTestConnection(
    /** @param {import("@tranjs/pg").TestConnection} db */
    async db => { await db.query("INSERT INTO docs_users VALUES ($1)", ["Ada"]); },
);
```

Call services outside `withTestConnection`, and use `db` only inside its callback: the connection and its methods stop working when the callback finishes. Each call uses its own savepoint, a database checkpoint that lets a failed statement roll back without breaking the rest of the test. Await every query; a query left running makes the call fail after it drains that query.

## Checking boundaries

`track` records the transaction at function entry. Track the repositories a service calls, as in the first test, rather than the service method that starts the transaction. Object methods supply useful names in failure messages. For a standalone spy, give it a name before tracking it, such as `vi.fn().mockName("publish")`.

| Jest / Vitest matcher | Assertion from `@tranjs/testing` | Checks |
|---|---|---|
| `expect(a).toRunInSameTransactionAs(b)` | `assertSameTransaction(a, b)` | Both calls entered the same transaction |
| `expect(a).toRunInSeparateTransactionFrom(b)` | `assertSeparateTransaction(a, b)` | Both entered transactions, and those transactions differ |
| `expect(a).toRunOutsideTransaction()` | `assertOutsideTransaction(a)` | The call entered without a transaction |
| `expect(a).toRunAfterCommitOf(b)` | `assertAfterCommitOf(a, b)` | The call ran through an `afterCommit` callback for b's transaction |
| `expect(a).toHaveCommitted()` | `assertCommitted(a)` | The call's transaction finished successfully |
| `expect(a).toHaveRolledBack()` | `assertRolledBack(a)` | The call's transaction rolled back |

Use functions from the same `tx`, with exactly one recorded call each, and await the transaction before checking its outcome. For repeated calls, compare records from `tx.txOf(fn, index)` instead. `.not` reverses a valid check; it still throws for untracked functions, missing calls or multiple calls. Two calls outside a transaction count as neither the same nor separate transactions.

A failure might include:

```text
Received: save → tx#1 (REQUIRED, committed), event 1
Other: record → tx#2 (REQUIRED, committed), event 3
```

`tx#1` identifies a transaction in this test, not a database connection. `event N` gives its place in the test's recorded sequence of calls and transaction completions; gaps between displayed calls are normal. Here the functions ran in different transactions. If the message says "0 calls recorded through the wrapper returned by track()", check that the service received the tracked objects.

The portable assertions throw ordinary assertion errors and work without matcher registration.

Tracking follows calls through the returned objects, not calls through the originals or internal `this.otherMethod()` calls. It preserves method receivers, including private-field access. The checks describe call entry, completion and hooks; use SQL assertions to check what your service wrote.

To check service rollback, catch its failure inside the callback and read back its rows with `withTestConnection` before the callback ends. That distinguishes the service's rollback from the test's final cleanup.

## Tests without a database

Use `mockTransactions` to check transaction handling with mocked data access. It temporarily registers a fake manager, then restores the previous registration. Run these tests sequentially for a given datasource, and mock repository SQL calls: a real driver's `ctx()` will reject the fake manager.

```typescript
// publish.test.ts (Vitest)
import { expect, test, vi } from "vitest";
import { afterCommit, transactional } from "@tranjs/core";
import { mockTransactions } from "@tranjs/testing";

test("publishes after saving", () => mockTransactions(async tx => {
    const repository = tx.track({ save: vi.fn().mockName("save") });
    const mailer = tx.track({ publish: vi.fn().mockName("publish") });
    const service = transactional(() => {
        repository.save();
        afterCommit(mailer.publish);
        expect(mailer.publish).not.toHaveBeenCalled();
    });
    await service();
    expect(repository.save).toHaveCommitted();
    expect(mailer.publish).toRunAfterCommitOf(repository.save);
}));
```

`toRunAfterCommitOf` checks that the call came through that transaction's hook. Calling a function later, outside a transaction, is a different case.

For node:test, call the portable assertions directly:

```typescript
// boundaries.test.ts (node:test)
import { test } from "node:test";
import { transactional } from "@tranjs/core";
import { assertSameTransaction, mockTransactions } from "@tranjs/testing";

test("shares a transaction", () => mockTransactions(async tx => {
    const repository = tx.track({ save() {}, audit() {} });
    const save = transactional(() => { repository.save(); repository.audit(); });
    await save();
    assertSameTransaction(repository.save, repository.audit);
}));
```

## Simulating failures

Register a failure with `tx.failNext("begin" | "commit" | "rollback", selector?)` before running the service. Both test helpers support it. This lets you check what happens when a transaction operation fails:

```typescript
// failure.test.ts (Vitest)
import { expect, test, vi } from "vitest";
import { afterCommit, afterRollback, transactional } from "@tranjs/core";
import { mockTransactions } from "@tranjs/testing";

test("skips publication when commit fails", () => mockTransactions(async tx => {
    const repository = tx.track({ save: vi.fn().mockName("save") });
    const publish = vi.fn().mockName("publish");
    const rollback = vi.fn().mockName("rollback");
    const error = new Error("connection lost");
    tx.failNext("commit", { containing: repository.save, error });
    const service = transactional(() => {
        repository.save();
        afterCommit(publish);
        afterRollback(rollback);
    });
    await expect(service()).rejects.toBe(error);
    expect(repository.save).toHaveRolledBack();
    expect(publish).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledTimes(1);
}));
```

Use `containing` to select a transaction that called a tracked function, or `where` to select by its record. Choose one of these filters. `times` sets how many matching operations fail and defaults to one; `error` is the value to throw. With no selector, the next matching operation fails. For begin failures, use `where` or no filter, since the function has not run yet. This simulates transaction operations, rather than statement errors or network failures.

## How tests differ from production

`withTestTransaction` opens a test transaction and rolls it back when the callback finishes. A transaction your code starts uses a savepoint inside it. In this mode, "committed" means that transaction finished successfully and its changes are visible to later calls in the test; the final rollback still removes them.

| Behavior | Production | `withTestTransaction` |
|---|---|---|
| Database transactions | Your code opens and finishes transactions | One test transaction; transactions your code starts use savepoints |
| `ctx()` outside a transaction your code starts | Throws | Also throws; use `withTestConnection` for test setup and reads |
| `REQUIRED`, `MANDATORY`, `SUPPORTS` | Join or require an existing transaction according to their propagation rules | The same rules; the test transaction does not count as one your code started |
| `NESTED` | A savepoint shares its enclosing transaction's state, hooks and deadline | The same sharing, including one shared probe record |
| `REQUIRES_NEW` | An independent transaction with its own connection and committed data | A separate record on the same connection; sees enclosing writes and rolls back with them |
| Commit hooks | Run after the database commits | Run after a successful savepoint, before the test's final rollback |
| Service `isolationLevel` / `readOnly` | Apply when a database transaction starts | Recorded, but do not change the test transaction's settings |
| Timeouts | Transaction deadlines and driver query checks | The same checks; arbitrary I/O may finish later and server cancellation depends on the driver |
| Deferred PostgreSQL constraints | Checked according to their modes, including at COMMIT | Checked when a service or `NESTED` savepoint finishes, with the prior modes restored |
| Caught PostgreSQL statement error | An aborted COMMIT rejects with `TransactionAbortedError` in pg and postgres.js | Savepoint completion rejects with the same class and retains the native error as `cause` |
| Injected commit/rollback failures | Real failures can leave the result uncertain | Savepoint recovery rolls back the affected writes; it does not reproduce an uncertain COMMIT |
| A transaction still running when the callback returns | The caller must await it | The helper drains it and fails the test for the forgotten `await` |
| Parallel transactions | Can use independent connections | Separate tests can run in parallel; transaction branches inside one callback must run sequentially |

Await all work, including timers, inside the callback. Put rollback-sensitive setup and checks there too; runner hooks run outside it. Run `withTestConnection` calls and service calls one at a time, and use separate top-level callbacks rather than nested `withTestTransaction` calls.

### What is not rolled back

- SQL on raw connections, other datasources, or independent work started with `NOT_SUPPORTED`.
- Explicit transaction-control SQL and DDL that commits implicitly, such as MySQL schema changes. Apply migrations separately.
- Sequence increments, emails, HTTP calls, files, caches and mock state. Mock external effects or clean them up separately.
- Detached work that runs after the callback, including unawaited timers or runner callbacks. A missing `await` is detectable only while the helper can still track the work.

## Tests that need real commits

Use ordinary `transactional` functions for durability, locks, races, isolation settings and independent `REQUIRES_NEW` visibility. Run these tests without either testing helper. Write the data, read it in a fresh transaction, then clean up in `finally`:

```typescript
// commits.test.ts (node:test, using the migrated docs_users table)
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { transactional } from "@tranjs/core";
import { ctx, usePostgreSQLTransactionManager } from "@tranjs/pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
usePostgreSQLTransactionManager(pool);
after(() => pool.end());

test("reads a committed change from a fresh transaction", async () => {
    const name = randomUUID();
    const create = transactional(() => ctx().query("INSERT INTO docs_users VALUES ($1)", [name]));
    const read = transactional(() => ctx().query("SELECT name FROM docs_users WHERE name = $1", [name]));
    try {
        await create();
        assert.deepEqual((await read()).rows, [{ name }]);
    } finally {
        await transactional(() => ctx().query("DELETE FROM docs_users WHERE name = $1", [name]))();
    }
});
```

For concurrency tests, allow enough connections for independent transactions, and give each test its own data or schema.

## Reference

### Probe and options

Both helpers pass a probe as `tx` and return a Promise of the callback's result. `currentProbe(datasource?)` retrieves that probe inside a live callback and throws outside it.

| Member | Meaning |
|---|---|
| `tx.track(target)` | Returns a tracked function or object with the same public type |
| `tx.txOf(fn, index = 0)` | The record for a zero-based call, or `undefined` for a call outside a transaction; missing calls and untracked functions throw |
| `tx.records` | A read-only snapshot of transactions started by your code, including failed begins |
| `tx.datasource` | The selected datasource |
| `tx.failNext(operation, selector?)` | Registers a failure as described [above](#simulating-failures) |

A record has `id`, `propagation`, requested `options`, `parent`, and `outcome` (`"active"`, `"committed"`, or `"rolled-back"`). Joined calls and `NESTED` share a record. `REQUIRES_NEW` has a separate record; `parent` identifies the transaction active when it started, so a transaction inside `NOT_SUPPORTED` has no parent.

All three helpers accept `TestOptions`: `{ datasource?: string | symbol }`. `withTestTransaction` and `mockTransactions` select the default registration when it is omitted; `withTestConnection` uses the current test's datasource. Put transaction policy such as `timeout` on the service's `transactional` or `@Transactional` call.

### Errors

Pending work produces an `AggregateError` with the unfinished-work message and any callback or operation errors in `errors`. Cleanup and recovery failures preserve earlier errors through `TransactionSystemError.cause` and `.applicationError`; see the [error reference](api.md#errors). If recovery fails, finish ordinary resource cleanup in `finally` and let the test fail; if final database cleanup fails, reset the test database before reusing it.
