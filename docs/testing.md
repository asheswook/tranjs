# Testing

`@tranjs/testing` runs a service against a real database and rolls back its changes after the test. It also checks which calls share a transaction, and tests transaction handling with mocked repositories and no database. It works with any runner and is tested with Jest 29 and 30, Vitest 3 to 5 and node:test.

`@tranjs/testing` is a separate dev dependency. It needs `@tranjs/core` 1.2.0 or later. `withTestConnection` also needs `@tranjs/pg` or `@tranjs/mysql2` 1.3.0, or `@tranjs/postgres` 1.2.0.

```bash
# @tranjs/testing is a dev dependency, next to @tranjs/core and a driver.
npm install --save-dev @tranjs/testing
```

## First test

`withTestTransaction(fn)` runs `fn` inside a test transaction and rolls it back afterwards. `tx`, the probe passed to the callback, records calls and transactions for assertions. `tx.track(target)` returns a wrapper that records each call and the transaction it ran in, so the code under test has to hold the wrapper. The examples pass it through a factory or constructor; assigning a tracked function over a method for the length of the test works too.

This service saves a user and an audit entry in one transaction. It assumes a registered `pg` manager and the two example tables from [Example setup](#example-setup).

```typescript
// users.test.ts (Jest + pg). Assumes a registered pg manager and the
// example tables example_users(name) and example_audit(name).
import { expect, test } from "@jest/globals";
import { transactional } from "@tranjs/core";
import { ctx } from "@tranjs/pg";
import { withTestTransaction } from "@tranjs/testing";
import "@tranjs/testing/jest";

const usersRepo = { save: (name: string) => ctx().query("INSERT INTO example_users(name) VALUES ($1)", [name]) };
const auditRepo = { record: (name: string) => ctx().query("INSERT INTO example_audit(name) VALUES ($1)", [name]) };
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

`transactional(fn)` creates a function. Calling that function starts the transaction. Here, `service.create("Ada")` makes that call.

Classes with `@Transactional` methods behave the same. Here the tracked repositories go in through the constructor. The example needs TypeScript's `experimentalDecorators` option:

```typescript
// decorated.test.ts (Jest + pg). Assumes a registered pg manager and the
// example tables example_users(name) and example_audit(name).
import { expect, test } from "@jest/globals";
import { Transactional } from "@tranjs/core";
import { ctx } from "@tranjs/pg";
import { withTestTransaction } from "@tranjs/testing";
import "@tranjs/testing/jest";

const usersRepo = { save: (name: string) => ctx().query("INSERT INTO example_users(name) VALUES ($1)", [name]) };
const auditRepo = { record: (name: string) => ctx().query("INSERT INTO example_audit(name) VALUES ($1)", [name]) };
class UserService {
    constructor(private readonly users: typeof usersRepo, private readonly audit: typeof auditRepo) {}

    @Transactional()
    async create(name: string) {
        await this.users.save(name);
        await this.audit.record(name);
    }
}

test("saves through a decorated service", () => withTestTransaction(async tx => {
    const users = tx.track(usersRepo);
    const audit = tx.track(auditRepo);
    const service = new UserService(users, audit);
    await service.create("Ada");
    expect(users.save).toRunInSameTransactionAs(audit.record);
}));
```

## Example setup

`withTestTransaction` needs one thing: a manager registered for its datasource, in the same module registry as the test. Without one it rejects with `DatasourceSetupError`. By default Jest and Vitest give each test file its own registry, and `globalSetup` runs outside all of them, so a registration made there is not visible to tests.

Where the registration lives, which database it points to and how the schema gets there are up to the project. The helper never creates or migrates schema. Whatever is listed under [What is not rolled back](#what-is-not-rolled-back) stays in that database, which is the trade-off between a dedicated test database and a shared development one.

The snippets in this guide share one arrangement so they run as written: Jest, `pg`, a setup module at `test/database.ts` and two throwaway tables. None of it is required.

```sql
-- Example tables for the snippets in this guide.
-- Not part of @tranjs/testing: any schema works.
CREATE TABLE example_users (name text NOT NULL);
CREATE TABLE example_audit (name text NOT NULL);
```

```typescript
// Example: test/database.ts, loaded once per test file (Jest setupFilesAfterEnv).
// The path, pool options and env var name are illustrative.
import { afterAll } from "@jest/globals";
import { Pool } from "pg";
import { usePostgreSQLTransactionManager } from "@tranjs/pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
usePostgreSQLTransactionManager(pool);
afterAll(() => pool.end());
```

With Vitest the same module imports `afterAll` from `vitest` and is listed in `setupFiles`.

Each `withTestTransaction` call holds one pooled connection from its begin to its final rollback. Callbacks running concurrently hold one each, in every worker. `mockTransactions` holds none. Data written outside the callback (runner hooks, fixtures) is committed normally: it is visible to every worker and is not rolled back.

### Matcher registration

| Option | Covers | Notes |
|---|---|---|
| Runner config: `setupFilesAfterEnv: ["@tranjs/testing/jest"]` or `setupFiles: ["@tranjs/testing/vitest"]` | Every test file | Types come from `compilerOptions.types` or from one import anywhere in the project |
| `import "@tranjs/testing/jest"` (or `/vitest`) in a test file | That file | Registers the matchers and loads their types |
| `expect.extend(matchers)` with the exported `matchers` | Wherever it runs | For another `expect` implementation |
| No matchers: the `assert*` functions | Any runner | The only form available in node:test |

Example configs for the first option, with the example setup module in the same list:

```javascript
// jest.config.cjs
// "<rootDir>/test/database.ts" is the example setup module above; omit it if registration lives elsewhere.
module.exports = {
    setupFilesAfterEnv: ["@tranjs/testing/jest", "<rootDir>/test/database.ts"],
};
```

```javascript
// vitest.config.mjs
// "./test/database.ts" is the example setup module above; omit it if registration lives elsewhere.
import { defineConfig } from "vitest/config";
export default defineConfig({
    test: { setupFiles: ["@tranjs/testing/vitest", "./test/database.ts"] },
});
```

The bare package name is tested on Vitest 4 and 5. On Vitest 3, and in workspace layouts where the name does not resolve, a resolved file path works (needs a Node version with `import.meta.resolve`):

```javascript
// vitest.config.mjs (resolved path variant)
// "./test/database.ts" is the example setup module above; omit it if registration lives elsewhere.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
    test: { setupFiles: [
        fileURLToPath(import.meta.resolve("@tranjs/testing/vitest")),
        "./test/database.ts",
    ] },
});
```

Matcher types load with the per-file import. Projects that register through runner config and already set `compilerOptions.types` can list the entry there instead. Once `types` is set, TypeScript loads only the listed packages, so adding the array to a tsconfig that had none drops every other automatically included `@types` package.

```jsonc
// tsconfig.json (Jest). Only for projects that already list compilerOptions.types.
{ "compilerOptions": { "types": ["node", "@tranjs/testing/jest"] } }
```

```jsonc
// tsconfig.json (Vitest). Only for projects that already list compilerOptions.types.
{ "compilerOptions": { "types": ["node", "@tranjs/testing/vitest"] } }
```

## Seeding and reading data

`withTestConnection(fn)` runs `fn` with a restricted connection on the test transaction. It is available only inside a `withTestTransaction` callback. A `transactional` function that calls `ctx()` also works for seeding and reading; it shows up in `tx.records` and shifts the `tx#N` numbering, which `withTestConnection` does not.

`db` is typed by the callback's parameter annotation and is `unknown` without one. Each driver exports its `TestConnection` type. The annotation is not checked against the registered manager, so a mismatch is a runtime error, not a compile error.

```typescript
// seed.test.ts (Jest + pg). Assumes a registered pg manager and the
// example table example_users(name).
import { expect, test } from "@jest/globals";
import type { TestConnection } from "@tranjs/pg";
import { withTestConnection, withTestTransaction } from "@tranjs/testing";

test("reads the data prepared for this test", () => withTestTransaction(async () => {
    await withTestConnection(async (db: TestConnection) => {
        await db.query("INSERT INTO example_users(name) VALUES ($1)", ["Ada"]);
    });
    const names = await withTestConnection(async (db: TestConnection) => {
        const { rows } = await db.query("SELECT name FROM example_users ORDER BY name");
        return rows.map(row => row.name);
    });
    expect(names).toEqual(["Ada"]);
}));
```

A project that uses one driver's type often can wrap the annotation in a helper:

```typescript
// Optional helper (partial example)
import type { TestConnection } from "@tranjs/pg";
import { withTestConnection } from "@tranjs/testing";
import type { TestOptions } from "@tranjs/testing";

const withPgTestConnection = <R>(fn: (db: TestConnection) => R, options?: TestOptions) => withTestConnection(fn, options);
```

The other drivers export their own `TestConnection`. For example, these callbacks insert the same data:

```typescript
// Partial example: withTestConnection callbacks for mysql2 and postgres.js.
// Example table: example_users(name).
import type { TestConnection as MysqlConnection } from "@tranjs/mysql2";
import type { TestConnection as PostgresConnection } from "@tranjs/postgres";

export const seedMysql = (db: MysqlConnection) => db.execute("INSERT INTO example_users(name) VALUES (?)", ["Ada"]);
export const seedPostgres = (db: PostgresConnection) => db`INSERT INTO example_users(name) VALUES (${"Ada"})`;
```

| Driver | Methods on `db` | Result |
|---|---|---|
| pg | `query(text, values?)` | A Promise of the driver's `QueryResult` |
| mysql2 | `query(text, values?)`, `execute(text, values?)` | A Promise of the driver's `[rows, fields]` pair |
| postgres.js | Tagged SQL and `unsafe(text, values?)` | A plain Promise of the driver's row list |

These methods take SQL text and parameters, not query config objects or callback arguments. Connection controls, streams, cursors and driver query modifiers are outside this interface.

JavaScript example, typed with JSDoc:

```javascript
// Partial example (JavaScript): a seeding function for use inside withTestTransaction.
// Example table: example_users(name).
import { withTestConnection } from "@tranjs/testing";

export const seedAda = () => withTestConnection(
    /** @param {import("@tranjs/pg").TestConnection} db */
    async db => { await db.query("INSERT INTO example_users(name) VALUES ($1)", ["Ada"]); },
);
```

Each call uses its own savepoint, a database checkpoint that lets a failed statement roll back without breaking the rest of the test. Starting a transaction inside the callback throws `A transaction cannot start inside a withTestConnection callback`. `db` throws once the callback has finished, and returning `db` from the callback throws.

If a query sent through `db` is still pending when the `withTestConnection` callback finishes, the helper waits for that query, cleans up the savepoint and fails the call with `withTestConnection callback completed with pending query work`.

## Checking boundaries

`track` records the transaction that is current when the function is entered. A tracked function that itself starts the transaction is therefore recorded as outside one, which is why the examples track the repositories a service calls. Failure messages name a function by its mock name, then its property name on a tracked object, then its own name, and `<anonymous>` otherwise.

| Jest / Vitest matcher | Assertion from `@tranjs/testing` | Checks |
|---|---|---|
| `expect(a).toRunInSameTransactionAs(b)` | `assertSameTransaction(a, b)` | Both calls entered the same transaction |
| `expect(a).toRunInSeparateTransactionFrom(b)` | `assertSeparateTransaction(a, b)` | Both entered transactions, and those transactions differ |
| `expect(a).toRunOutsideTransaction()` | `assertOutsideTransaction(a)` | The call entered without a transaction |
| `expect(a).toRunAfterCommitOf(b)` | `assertAfterCommitOf(a, b)` | The call ran through an `afterCommit` callback of b's transaction and was itself outside a transaction |
| `expect(a).toHaveCommitted()` | `assertCommitted(a)` | The call's transaction finished successfully |
| `expect(a).toHaveRolledBack()` | `assertRolledBack(a)` | The call's transaction rolled back |

The matchers and `assert*` functions throw `TypeError` when the two functions belong to different probes, or when either has zero or more than one recorded call. `tx.txOf(fn, index)` returns the record of one call, for functions called more than once. A record's outcome is `"active"` until its transaction completes, so `toHaveCommitted` and `toHaveRolledBack` fail before then.

`.not` reverses a valid check. It still throws for untracked functions, missing calls or multiple calls. Two calls outside a transaction count as neither the same nor separate transactions.

A failure might include:

```text
Received: save → tx#1 (REQUIRED, committed), event 1
Other: record → tx#2 (REQUIRED, committed), event 3
```

`tx#1` identifies a transaction in this test, not a database connection. `event N` gives its place in the test's recorded sequence of calls and transaction completions. Gaps between displayed calls are normal. Here the functions ran in different transactions. If the message says "0 calls recorded through the wrapper returned by track()", the calls went through the original object, not the wrapper.

The `assert*` functions in the table throw ordinary assertion errors and work without matcher registration.

Tracking follows calls through the returned objects, not calls through the originals or internal `this.otherMethod()` calls. The originals keep working as before. Methods still use the original object as `this`, so private fields keep working. These checks tell which transaction a call ran in and how it finished. They do not look at data.

The final rollback removes everything, so a read made after the callback cannot tell a service rollback from it. A read inside the callback, after the service call has rejected, can.

## Tests without a database

`mockTransactions(fn)` runs `fn` with a fake manager registered for the datasource and restores the previous registration afterwards. No database is involved. The registration is process-wide for that datasource, so a second `mockTransactions` on the same datasource while one is open throws `Concurrent or nested mockTransactions for datasource … is not supported`. A real driver's `ctx()` throws `TransactionContextMixingError` under the fake manager, which is why the examples use mocked repositories.

```typescript
// publish.test.ts (Vitest). No database or registered manager is involved.
import { expect, test, vi } from "vitest";
import { afterCommit, transactional } from "@tranjs/core";
import { mockTransactions } from "@tranjs/testing";
import "@tranjs/testing/vitest";

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

`toRunAfterCommitOf` checks that the call came through that transaction's hook. Calling a function later, outside a transaction, is a different case. So is a hook that `afterCommit` calls immediately because its transaction had already finished: it is recorded as a call outside a transaction, and `toRunAfterCommitOf` fails for it. A function called inside a transaction that the hook starts does not match either; `tx.txOf(fn)` gives its record instead.

node:test has no `expect`. Example with the `assert*` functions:

```typescript
// boundaries.test.ts (node:test). No database or registered manager is involved.
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

`tx.failNext("begin" | "commit" | "rollback", selector?)` makes the next matching begin, commit or rollback throw. It applies to operations that start after the call. Both test helpers support it. Example of a failed commit:

```typescript
// failure.test.ts (Vitest). No database or registered manager is involved.
import { expect, test, vi } from "vitest";
import { afterCommit, afterRollback, transactional } from "@tranjs/core";
import { mockTransactions } from "@tranjs/testing";
import "@tranjs/testing/vitest";

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

| Selector option | Meaning |
|---|---|
| `containing` | Selects a transaction that called this tracked function |
| `where` | Selects a transaction by its record |
| `times` | Number of matching operations to fail; defaults to one |
| `error` | The value to throw |

Passing both `containing` and `where` throws `TypeError`. With no selector, the next matching operation fails. `containing` with `"begin"` throws, because no tracked call can have run before the transaction begins. Without `error`, the thrown value is `Error("Test transaction <operation> failed")`. This simulates transaction operations, not statement errors or network failures.

## How tests differ from production

`withTestTransaction` opens a test transaction and rolls it back when the callback finishes. A transaction the code under test starts uses a savepoint inside it. In this mode, "committed" means that transaction finished successfully and its changes are visible to later calls in the test. The final rollback still removes them.

| Behavior | Production | `withTestTransaction` |
|---|---|---|
| Database transactions | The code opens and finishes transactions | One test transaction; transactions the code starts use savepoints |
| `ctx()` outside a transaction the code starts | Throws | Also throws. `withTestConnection` and `transactional` functions both reach the test transaction. |
| `REQUIRED`, `MANDATORY`, `SUPPORTS` | Join or require an existing transaction according to their propagation rules | The same rules; the test transaction does not count as one the code started |
| `NESTED` | A savepoint shares its enclosing transaction's state and deadline. Its [hooks follow the savepoint](api.md#hooks-in-nested-scopes). | The same, including one shared probe record |
| `REQUIRES_NEW` | An independent transaction with its own connection and committed data | A separate record on the same connection; sees enclosing writes and rolls back with them |
| Hooks | Follow the commit or rollback of the database transaction | Follow the outcome of the transaction the code started, which is the outcome of its savepoint. They run before the final rollback, and the final rollback runs none. |
| Service `isolationLevel` / `readOnly` | Apply when a database transaction starts | Recorded, but do not change the test transaction's settings |
| Timeouts | Transaction deadlines and driver query checks | The same checks; arbitrary I/O may finish later and server cancellation depends on the driver |
| Deferred PostgreSQL constraints | Checked according to their modes, including at COMMIT | Checked when a service or `NESTED` savepoint finishes, with the prior modes restored |
| Caught PostgreSQL statement error | An aborted COMMIT rejects with `TransactionAbortedError` in pg and postgres.js | Savepoint completion rejects with the same class and retains the driver's error as `cause` |
| Injected commit/rollback failures | Real failures can leave the result uncertain | Savepoint recovery rolls back the affected writes; it does not reproduce an uncertain COMMIT |
| Parallel transactions | Can use independent connections | Separate tests can run in parallel; two transactions open at once inside one callback reject with `Transactions overlap inside withTestTransaction` |

Only work awaited inside the callback belongs to the test transaction.

- A service call made from a runner hook (`beforeEach`, `afterEach`, `onTestFinished`) is an ordinary transaction. It commits.
- So is one made from a fake timer that is flushed after the callback. A fake timer flushed inside a later test joins that test's transaction instead.
- A promise created inside the callback and settled later keeps the closed test's context: transactional work in it rejects with `TransactionClosedError`.
- Transactions on a second datasource commit: the callback covers one datasource, and a second `withTestTransaction` cannot be opened inside it.

A `withTestConnection` call that overlaps a transaction or another `withTestConnection` call throws. A `withTestTransaction` call inside another throws `Nested withTestTransaction calls are not supported`, including when the inner one names a different datasource.

See [connection lifetime](drivers.md#connection-lifetime) for what a connection does after a transaction or test ends.

### What is not rolled back

- SQL on raw connections, other datasources, or independent work started with `NOT_SUPPORTED`.
- Explicit transaction-control SQL and DDL that commits implicitly, such as MySQL schema changes. DDL inside a test therefore stays in the database on MySQL.
- Sequence increments, emails, HTTP calls, files, caches and mock state.
- External effects from detached work after the callback, including unawaited timers or runner callbacks. The helper does not stop that work.
- Queries that detached work sends through driver objects other than the `ctx()` connection after the test ends. With a pool, they can reach the next test. With the connection-per-transaction managers (`usePostgreSQLClientPerTransaction`, `useMySQLConnectionPerTransaction`) this is less likely, because each test's connection is closed when the test ends. A query sent while the test is finishing is still not caught.

## Tests that need real commits

`withTestTransaction` cannot show durability, lock waits, races, isolation settings or independent `REQUIRES_NEW` visibility: everything runs on one connection and nothing commits. Tests of those run without the helpers, as ordinary transactions. Example that writes, reads in a second transaction and deletes its own row:

```typescript
// commits.test.ts (node:test + pg). Example table: example_users(name text).
// The env var name is illustrative.
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
    const create = transactional(() => ctx().query("INSERT INTO example_users(name) VALUES ($1)", [name]));
    const read = transactional(() => ctx().query("SELECT name FROM example_users WHERE name = $1", [name]));
    try {
        await create();
        assert.deepEqual((await read()).rows, [{ name }]);
    } finally {
        await transactional(() => ctx().query("DELETE FROM example_users WHERE name = $1", [name]))();
    }
});
```

Each concurrent transaction in such a test holds its own connection, and its writes are visible to other tests.

## Reference

### Probe and options

Both helpers pass a probe as `tx` and return a Promise of the callback's result. `currentProbe(datasource?)` retrieves that probe inside a live callback and throws outside it.

| Member | Meaning |
|---|---|
| `tx.track(target)` | Returns a tracked function or object with the same public type |
| `tx.txOf(fn, index = 0)` | The record for a zero-based call, or `undefined` for a call outside a transaction; missing calls and untracked functions throw |
| `tx.records` | A read-only snapshot of transactions started by the code under test, including failed begins |
| `tx.datasource` | The selected datasource |
| `tx.failNext(operation, selector?)` | Registers a failure; see [Simulating failures](#simulating-failures) |

A `TestTransactionRecord` has `id`, `propagation`, requested `options`, `parent`, and `outcome` (`"active"`, `"committed"`, or `"rolled-back"`). Joined calls and `NESTED` share a record. `REQUIRES_NEW` has a separate record. Its `parent` is the transaction it started inside. `NOT_SUPPORTED` suspends the current transaction, so a transaction started there has no parent.

All three helpers accept `TestOptions`: `{ datasource?: string | symbol }`. `withTestTransaction` and `mockTransactions` select the default registration when it is omitted. `withTestConnection` uses the current test's datasource. `TestOptions` has no transaction options. `timeout`, `isolationLevel` and `readOnly` come from the code under test.

### Errors

| Thrown by | When | Error |
|---|---|---|
| `withTestTransaction` | No manager for the datasource | `DatasourceSetupError` |
| `withTestTransaction` | Called inside another, any datasource | `Nested withTestTransaction calls are not supported` |
| A transaction in the callback | Another is still open | `Transactions overlap inside withTestTransaction` |
| `mockTransactions` | Another is open on the same datasource | `Concurrent or nested mockTransactions for datasource … is not supported` |
| `withTestConnection` | Outside a `withTestTransaction` callback | `withTestConnection requires an active withTestTransaction callback` |
| `withTestConnection` | Inside `mockTransactions` | `withTestConnection is unavailable in mockTransactions` |
| `withTestConnection` | Custom driver | `This transaction manager does not support withTestConnection` |
| `withTestConnection` | Inside a transaction, hook or another connection callback | `withTestConnection was called inside another connection callback, a transaction callback or a transaction hook` |
| `currentProbe` | Outside a live callback | `currentProbe() requires an active transaction test callback` |
| Work kept from a finished test | Any transactional call | `TransactionClosedError` |
| `withTestTransaction` | The callback threw and the final rollback or release failed too | `TransactionSystemError`: `cause` is the cleanup error, `applicationError` the earlier one |
| `withTestTransaction` | Only the final rollback or release failed | That error itself |

See the [error reference](api.md#errors) for the error classes.

If the final rollback fails, the helper releases the connection as failed. `pg`, `mysql2` and postgres.js 4.x close it, and the server discards the transaction. postgres.js 3.x returns it to the pool with the transaction open, so later work on that pool can end up inside it.
