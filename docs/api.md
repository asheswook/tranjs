# API

## Setup

Register a transaction manager once, at startup or module scope. The native [drivers](drivers.md) provide registration helpers:

```typescript
import { Pool } from "pg";
import { usePostgreSQLTransactionManager } from "@tranjs/pg";

const pool = new Pool({ connectionString: process.env.PG_URL });
usePostgreSQLTransactionManager(pool);
```

Do not re-register per request. Registration replaces the shared manager, but active contexts belong to the original instance; concurrent requests can then fail with `"Transaction context not initialized"`.

For a [custom driver](self-implement-guide.md), use `useTransactionManager(manager, name?)`. Omitting the name selects the default datasource. `getTransactionManager(name?)` retrieves a registered manager.

`clearTransactionManager(name?)` is a public export from the main `@tranjs/core` entry point. It removes the default or named registration and does nothing if none is registered. Transactions already in progress are unchanged; future manager lookups throw `DatasourceSetupError` until a manager is registered again. Use it for registration teardown, not while other work is using that datasource.

```typescript
import { clearTransactionManager } from "@tranjs/core";

clearTransactionManager(); // Default datasource.
clearTransactionManager("analytics"); // Named datasource; symbols are also accepted.
```

## Transaction scopes

`@Transactional()` wraps an async method. It accepts either a `Propagation` value or a `TransactionConfig`. It preserves the method's `this`, name, and `reflect-metadata` metadata when that optional package is present, including when used with decorators such as NestJS's.

```typescript
import { IsolationLevel, Propagation, Transactional } from "@tranjs/core";
import { ctx } from "@tranjs/pg";

class UserService {
    @Transactional({
        propagation: Propagation.REQUIRED,
        isolationLevel: IsolationLevel.SERIALIZABLE,
        readOnly: false,
        timeout: 5000,
    })
    async create(name: string) {
        const { rows } = await ctx().query(
            "INSERT INTO users(name) VALUES ($1) RETURNING *", [name],
        );
        return rows[0];
    }
}
```

`transactional(fn, config?)` creates a callable transaction wrapper. Calling it forwards arguments unchanged and preserves dynamic, invocation-time `this`. Synchronous values and thenables are accepted; every propagation returns a Promise of the awaited result, including setup failures as rejections. Configuration is snapshotted at wrapper creation; manager lookup happens at invocation.

```typescript
function transactional<This, Args extends unknown[], R>(
    fn: (this: This, ...args: Args) => R, config?: TransactionConfig,
): (this: This, ...args: Args) => Promise<Awaited<R>>;
```

```typescript
import { IsolationLevel, transactional } from "@tranjs/core";
import { ctx } from "@tranjs/pg";

const createUser = transactional(async (name: string) => {
    const { rows } = await ctx().query(
        "INSERT INTO users(name) VALUES ($1) RETURNING *", [name],
    );
    return rows[0];
}, { isolationLevel: IsolationLevel.SERIALIZABLE });

const user = await createUser("Ada");
```

### TransactionConfig

| Option | Type | Default |
|---|---|---|
| `propagation` | `Propagation` | `Propagation.REQUIRED` |
| `datasource` | `string \| symbol` | Default datasource (`DEFAULT_DATASOURCE`) |
| `isolationLevel` | `IsolationLevel` | Database default |
| `readOnly` | `boolean` | No read-only request |
| `timeout` | `number` (milliseconds) | No deadline |

`TransactionOptions` contains only `isolationLevel`, `readOnly`, and `timeout`. `TransactionConfig` extends it with `propagation` and `datasource`.

## Propagation

| Propagation | With a current transaction | Without one |
|---|---|---|
| `REQUIRED` | Join it | Begin one |
| `REQUIRES_NEW` | Suspend it and begin an independent transaction; resume afterward | Begin one |
| `MANDATORY` | Join it | Throw `IllegalTransactionStateException` |
| `SUPPORTS` | Join it | Run without a transaction |
| `NOT_SUPPORTED` | Suspend it and run without a transaction; resume afterward | Run without a transaction |
| `NEVER` | Throw `IllegalTransactionStateException` | Run without a transaction |
| `NESTED` | Create a savepoint on the same connection | Begin one, as with `REQUIRED` |

Propagation is tracked per datasource. A scope on datasource B never joins a transaction on datasource A. All native drivers support savepoints.

## Rollback rules

If a method throws, its transaction rolls back and the error is rethrown. Errors caught inside the same method don't affect the transaction.

If a method that joined an existing transaction (`REQUIRED`, `MANDATORY`, `SUPPORTS`) throws, the whole transaction is marked **rollback-only**. Catching the error in the outer method doesn't undo that: when the outer method returns, the transaction rolls back and `UnexpectedRollbackError` is thrown.

A failing `NESTED` scope rolls back to its savepoint. A successful savepoint rollback clears the **entire** rollback-only flag, including any flag set before that nested scope began. If a nested callback returns normally while rollback-only, core rolls back to the savepoint, clears the flag, and throws `UnexpectedRollbackError`. The outer callback may catch it and commit. A failed savepoint rollback is logged, leaves the transaction rollback-only, and preserves the original exception. Resetting rollback-only never extends the deadline; the owner still checks it before commit.

Run sibling `NESTED` scopes one after another. Nesting them inside each other is fine, but running two at once in the same parent (for example with `Promise.all`) throws `ConcurrentNestedTransactionError`.

`REQUIRES_NEW` runs in its own transaction. If you catch its failure, the outer transaction can still commit.

If physical rollback fails, `TransactionSystemError` preserves both failures; see [Errors](#errors). If commit fails, core does not attempt rollback: it runs `afterRollback` hooks and rethrows the commit error. The outcome may be uncertain, so those hooks do not guarantee that the database rolled back. Do not blindly retry non-idempotent work. Native pool managers dispose of connections after failed commit or rollback; per-transaction managers close their connections after completion.

## Isolation, readOnly, and timeout

These options apply only when a physical transaction begins: `REQUIRED` or `NESTED` without an existing transaction, or `REQUIRES_NEW`. Joined and savepoint scopes inherit the current transaction's settings.

`IsolationLevel` provides `READ_UNCOMMITTED`, `READ_COMMITTED`, `REPEATABLE_READ`, and `SERIALIZABLE`. Native drivers apply isolation and read-only settings with database SQL; see [driver setup and limitations](drivers.md).

### Deadlines

`timeout` must be finite, nonnegative, and at most `2147483647` ms. It establishes a physical transaction deadline that includes begin time. `REQUIRES_NEW` gets its own deadline.

Use the native driver's `ctx()` wrapper rather than a raw connection. Before each PostgreSQL `query()` or MySQL `query()` / `execute()`, it checks the deadline. Expiry marks the transaction rollback-only and throws `TransactionTimeoutError` without dispatching the query.

For ordinary queries, the wrapper passes the **remaining** time as PostgreSQL `query_timeout` or MySQL `timeout`. This overrides user per-query timeouts and pool defaults, even shorter ones. A timeout from that injected timer is translated to `TransactionTimeoutError`. Without a transaction deadline, user options are untouched.

PostgreSQL Submittables (`pg.Query`, `pg-query-stream`, `pg-cursor`) are checked only before dispatch and passed through untouched. No per-query timeout is injected, and execution or stream events are not intercepted. Consume streams inside the transactional callback so they finish before commit.

These are client-side timeouts, not server-side cancellation. PostgreSQL does not set `SET LOCAL statement_timeout`. A running statement can finish before queued rollback completes, so completion can take longer than the deadline. The deadline does not interrupt arbitrary JavaScript or other I/O. Core checks it again after the callback, before commit. A rollback failure takes precedence as `TransactionSystemError`.

## Hooks

```typescript
import { afterCommit, afterRollback, Transactional } from "@tranjs/core";
import { ctx } from "@tranjs/pg";

class OrderService {
    @Transactional()
    async create(id: string) {
        await ctx().query("INSERT INTO orders(id) VALUES ($1)", [id]);
        afterCommit(() => { console.log("Order committed:", id); });
        afterRollback(() => { console.error("Order failed:", id); });
    }
}
```

`afterCommit(fn, datasource?)` and `afterRollback(fn, datasource?)` accept synchronous or async callbacks. They attach to the current physical transaction of the selected datasource (the default if omitted), including when registered inside `NESTED`.

| Hook | Behaviour |
|---|---|
| `afterCommit` | Runs sequentially in registration order after successful commit. The first error stops later hooks and propagates to the caller. The transaction remains committed; no rollback or `afterRollback` hooks run. |
| `afterRollback` | Runs in registration order after rollback, including failed rollback, or after failed commit. Errors are logged and swallowed so later hooks still run. |

Without an active transaction, `afterCommit` invokes the callback immediately and returns its result; `afterRollback` does nothing. Use `manager.setLogger(logger)` to replace the default console-backed logger.

## Multiple datasources

Register each manager under a string or symbol name, then use the same name in the transaction config, `ctx()`, and hooks.

```typescript
import { Transactional } from "@tranjs/core";
import { ctx, usePostgreSQLTransactionManager } from "@tranjs/pg";
import { Pool } from "pg";

const primaryPool = new Pool({ connectionString: process.env.PG_URL });
const analyticsPool = new Pool({ connectionString: process.env.ANALYTICS_URL });
usePostgreSQLTransactionManager(primaryPool);
usePostgreSQLTransactionManager(analyticsPool, "analytics");

class ReportService {
    @Transactional({ datasource: "analytics" })
    async build() {
        return ctx("analytics").query("SELECT 1");
    }
}
```

## Testing helpers

| Entry point | Exports |
|---|---|
| `@tranjs/testing` | `withTestTransaction`, `mockTransactions`, `currentProbe`, `withTestConnection`, `TestOptions` (type), `matchers`, and portable assertions: `assertSameTransaction`, `assertSeparateTransaction`, `assertOutsideTransaction`, `assertAfterCommitOf`, `assertCommitted`, `assertRolledBack` |
| `@tranjs/testing/jest` | Side-effect registration of six matchers through `expect` from `@jest/globals`, plus `matchers` and types (Jest 29/30; supports `injectGlobals: false`) |
| `@tranjs/testing/vitest` | ESM side-effect registration of six matchers through Vitest's `expect`, plus `matchers` and types (Vitest 3/4/5) |

`@tranjs/testing@1.2.0` is a separate package with a required exact peer on `@tranjs/core@1.2.0`; runner peers are optional. Drivers: `@tranjs/pg@1.3.0`, `@tranjs/mysql2@1.3.0`, `@tranjs/postgres@1.2.0`. Manual `expect.extend(matchers)` is also supported.

- `withTestTransaction(fn, options?)`: rolls back awaited transactional work through the selected manager, including services, `transactional` and `@Transactional`. It does not contain raw connections, other datasources, detached work, external effects, or fixtures outside the callback. Owners use savepoints; "committed" is logical completion, not physical durability.
- `mockTransactions(fn, options?)`: runs `fn` with a fake manager and no database, to check transaction boundaries and failure handling.
- `currentProbe()`: returns the current live session's probe (also passed to `fn`); throws outside a live session. It exposes `track`, `txOf`, `failNext`, `records`, and `datasource`.
- `options` is `{ datasource?: string | symbol }`.

```typescript
function withTestConnection<C, R>(
    fn: (db: C) => R, options?: TestOptions,
): Promise<Awaited<R>>;
// TestOptions: { datasource?: string | symbol }
```

`withTestConnection` requires a live integration `withTestTransaction` session, not `mockTransactions`. It supplies a restricted connection without changing what driver `ctx()` or `getCurrentTransaction()` returns. Use type-only `import("@tranjs/pg").TestConnection`, `import("@tranjs/mysql2").TestConnection`, or `import("@tranjs/postgres").TestConnection` from the matching driver. Annotations do not validate datasource wiring. Do not pass this connection into application code.

Each fixture call uses one savepoint. A fixture does not create a service transaction or add a transaction to the probe. TranJS timeouts do not apply; database timeouts still do. You cannot start transactions through TranJS inside a fixture callback, on any datasource; all seven propagation modes are rejected before their callbacks run. Do not nest fixtures or call them from transactional callbacks or commit/rollback hooks, including `afterCommit` callbacks that run immediately without a transaction. Run fixtures and transactional work sequentially: overlapping calls are rejected as soon as they start, even before the first await. Await the callback's returned value and every query. The connection and its methods stop working when the callback finishes. Queries still pending at that point fail the fixture call, which waits for them to finish before releasing the savepoint. When the session ends, it rejects new fixture calls, waits for existing calls, and preserves unfinished-work and cleanup errors.

SQL errors roll back to and release the fixture savepoint while preserving native errors. If recovery fails, the session cannot continue safely: both errors are preserved, and session cleanup fails even if you catch the fixture error. This recovery differs from production. Keep the connection and its methods inside the callback. Returned data is not checked for nested connection references, and not every missing await is detectable. Fixtures are not a SQL sandbox: explicit COMMIT, DDL, sequences, and external effects can escape rollback.

**The hidden transaction is not ambient.** Application and assertion SQL needs `transactional` or `@Transactional`; test-only DML can use `withTestConnection`. Fixtures do not make the hidden transaction available through driver `ctx()`. Schema migrations run separately. For real commit semantics, use no session, seed/work via `transactional`, verify through a fresh independent transaction, and clean up in `finally` or use a disposable database. Concurrency tests use independent physical transactions outside sessions. Full policies, examples and limitations: [testing guide](testing.md).

The core main entry loads no `@tranjs/testing`, probe, fake manager, matcher or runner code. Testing AsyncLocalStorage is allocated only when a session starts; the internal bridge is inert without a session.

## Errors

All classes are exported by `@tranjs/core` except where a driver package is named.

| Class | When thrown | Notes |
|---|---|---|
| `TransactionSystemError` | Physical rollback fails | Message: `"Transaction rollback failed after application error"`. `cause` is the rollback error; `applicationError` is the original exception, timeout, or rollback-only decision. The original error is also logged. |
| `UnexpectedRollbackError` | An owner or `NESTED` callback returns while rollback-only | See [rollback rules](#rollback-rules) for savepoint reset behaviour. |
| `TransactionTimeoutError` | A transaction deadline expires or its injected query timer fires | Marks rollback-only; physical rollback can replace it with `TransactionSystemError`. |
| `InvalidIsolationLevelError` | A new physical transaction receives an invalid isolation level | Extends `TypeError`; validation happens before begin. |
| `ConcurrentNestedTransactionError` | A sibling `NESTED` scope is still open in the same parent scope | Run siblings sequentially. |
| `NestedTransactionNotSupportedError` | A manager without savepoint support receives `NESTED` inside a transaction | Extends `UnsupportedTransactionPropagationException`. |
| `DatasourceSetupError` | The requested datasource has no registered manager | Its `.name` is `"TransactionDatasourceSetupError"`. |
| `IllegalTransactionStateException` | `MANDATORY` has no transaction, or `NEVER` has one | Propagation constraint violation. |
| `TransactionContextMixingError` | A native driver's `ctx()` resolves a manager of another driver | Match the driver and datasource. |
| `TransactionAbortedError` (`@tranjs/pg`, `@tranjs/postgres`) | PostgreSQL rolls back a `COMMIT` because a query in the transaction failed | `afterRollback` hooks run. Nothing from the transaction was saved. |
| `NoTransactionContextError` | The deprecated core `ctx()` has no active context | Native `ctx()` instead throws `Error("Transaction context not initialized")` when its registered manager has no active transaction. |
| `UnsupportedTransactionPropagationException` | An unsupported propagation value is passed | Use a member of `Propagation`. |
| `UnsupportedIsolationLevelError` (`@tranjs/mysql2`) | Connection-per-transaction mode receives an explicit isolation level with its default rejection policy | Rejected before connecting; exposes `isolationLevel`. See [Hyperdrive limitations](drivers.md#mysql). |
| `RangeError` (built-in) | A new physical transaction receives an invalid timeout | See [deadline limits](#deadlines). |
