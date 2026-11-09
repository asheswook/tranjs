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

`runInTransaction(fn, config?)` is the functional equivalent. The callback may return a value or a Promise; the result is always a Promise, including setup failures as rejections.

```typescript
import { IsolationLevel, runInTransaction } from "@tranjs/core";
import { ctx } from "@tranjs/pg";

const createUser = (name: string) => runInTransaction(async () => {
    const { rows } = await ctx().query(
        "INSERT INTO users(name) VALUES ($1) RETURNING *", [name],
    );
    return rows[0];
}, { isolationLevel: IsolationLevel.SERIALIZABLE });
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

Propagation is tracked per datasource. A scope on datasource B never joins a transaction on datasource A. Both native drivers support savepoints.

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

## Errors

Classes are exported by `@tranjs/core` unless a driver package is named below. Database and hook errors also propagate as described above.

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
| `NoTransactionContextError` | The deprecated core `ctx()` has no active context | Native `ctx()` instead throws `Error("Transaction context not initialized")` when its registered manager has no active transaction. |
| `UnsupportedTransactionPropagationException` | An unsupported propagation value is passed | Use a member of `Propagation`. |
| `UnsupportedIsolationLevelError` (`@tranjs/mysql2`) | Connection-per-transaction mode receives an explicit isolation level with its default rejection policy | Rejected before connecting; exposes `isolationLevel`. See [Hyperdrive limitations](drivers.md#mysql). |
| `RangeError` (built-in) | A new physical transaction receives an invalid timeout | See [deadline limits](#deadlines). |
