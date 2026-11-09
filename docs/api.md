# TranJS API Documentation

## Decorator

- `@Transactional(arg?)`
    - Runs the method inside a transaction. Only works on async methods.
    - `arg` is either a `Propagation` (default `REQUIRED`) or a `TransactionConfig`:

```typescript
@Transactional({
    propagation: Propagation.REQUIRED,
    isolationLevel: IsolationLevel.SERIALIZABLE,
    readOnly: true,
    timeout: 5000,          // ms
    datasource: "replica",  // name given to useTransactionManager / use*TransactionManager
})
```

The decorator keeps the method's `this`, its `name`, and its `reflect-metadata` metadata, so it works next to other decorators such as NestJS's.

## Usage

### 1. Initialize the transaction manager

```typescript
import { useTransactionManager } from "@tranjs/core";

useTransactionManager(new YOUR_TX_MANAGER());
```

Put `YOUR_TX_MANAGER` that you want to use. If you want to use Native supported drivers, see [Native Drivers for TranJS](/docs/drivers.md).

Or you can implement your own driver. See [Self-Implementation Database Driver](/docs/self-implement-guide.md).

### 2. Use `@Transactional` decorator

```typescript
import { Transactional } from '@tranjs/core';
import { ctx } from '@tranjs/mysql2';

class MyService {
    @Transactional()
    async createUser(id: string, name: string) {
        const res = await ctx().execute(
            "INSERT INTO user (id, name) VALUES (?, ?)",
            [id, name],
        );
        
        return res;
    }
}
```

## Propagations

| Propagation Type | Supported | Description |
|------------------|:---------:|-------------|
| REQUIRED         | O | Joins the current transaction if one exists; otherwise begins a new one. |
| REQUIRES_NEW     | O | Suspends the current transaction and always begins a new one. The outer transaction resumes afterward. |
| MANDATORY        | O | Joins the current transaction; throws `IllegalTransactionStateException` if none exists. |
| SUPPORTS         | O | Joins the current transaction if one exists; otherwise runs without a transaction. |
| NOT_SUPPORTED    | O | Suspends the current transaction and runs without one. |
| NEVER            | O | Runs without a transaction; throws `IllegalTransactionStateException` if one exists. |
| NESTED           | O | Inside a transaction, creates a savepoint on the same connection. If the method throws, only the work since the savepoint is rolled back and the outer transaction can still commit. Without a transaction, behaves like `REQUIRED`. Needs driver support (both native drivers support it). |

Propagation is tracked per datasource. A `REQUIRED` method on datasource B never joins a transaction that is open on datasource A.

Spring semantics apply: an error escaping a joined `REQUIRED`, `MANDATORY`, or `SUPPORTS` scope marks the physical transaction **rollback-only**, even if the caller catches it. Unless a successful savepoint rollback clears that flag, the owner then rolls back and throws `UnexpectedRollbackError` instead of committing. A caught `REQUIRES_NEW` failure is independent. Errors caught inside the same method do not cross a transactional scope and do not mark rollback-only.

A successful `NESTED` rollback to a savepoint clears the **entire** `rollbackOnly` flag, including a flag set before the nested scope began. If the nested callback returns normally while rollback-only, core rolls back to the savepoint, clears the flag, and throws `UnexpectedRollbackError`. The outer callback can catch this error and commit. Clearing the flag does not extend a deadline: the owner still rechecks it before commit and rolls back if it has expired.

## Isolation Level, Read-only, Timeout

```typescript
import { IsolationLevel } from "@tranjs/core";
```

`READ_UNCOMMITTED`, `READ_COMMITTED`, `REPEATABLE_READ`, `SERIALIZABLE`.

These options apply only when a new physical transaction begins (`REQUIRED` without an existing transaction, `REQUIRES_NEW`, `NESTED` without an existing transaction). A method that joins an existing transaction inherits its settings.

`timeout` (ms):
- A finite, non-negative duration no greater than `2147483647` ms, establishing a deadline for the physical transaction (including begin). Joined and savepoint scopes inherit it; `REQUIRES_NEW` has its own deadline.
- Before every `ctx().query()` (and MySQL `ctx().execute()`), the deadline is checked. Once expired, it marks rollback-only and throws `TransactionTimeoutError` without sending the query.
- For ordinary queries, the remaining duration, not the original duration, is passed as PostgreSQL `query_timeout` or MySQL query/execute `timeout`. This always overrides user per-query timeouts and pool defaults, even shorter ones. Without a transaction deadline, user options are untouched. Use the driver's `ctx()` wrapper rather than a raw connection to get these checks.
- PostgreSQL Submittables (`pg.Query`, `pg-query-stream`, `pg-cursor`) are checked only before dispatch and passed through untouched: no per-query timeout is injected and no execution or stream interception is added. Consume streams inside the transactional callback; the owner still checks the deadline before commit.
- These are client-side query timeouts, not server-side cancellation. A running statement can finish before the queued rollback completes; transaction completion may therefore take longer than the deadline. PostgreSQL no longer sets `SET LOCAL statement_timeout` at begin.
- The deadline is also checked after the callback before commit. It does not interrupt arbitrary JavaScript or other I/O. If rollback fails, `TransactionSystemError` is thrown instead.

## Functional API

Use `runInTransaction` when decorators aren't an option:

```typescript
import { runInTransaction } from "@tranjs/core";
import { ctx } from "@tranjs/pg";

const user = await runInTransaction(async () => {
    const { rows } = await ctx().query("INSERT INTO users(name) VALUES ($1) RETURNING *", ["kim"]);
    return rows[0];
}, { isolationLevel: IsolationLevel.SERIALIZABLE });
```

It accepts the same `TransactionConfig` as `@Transactional`.

## Transaction Hooks

```typescript
import { afterCommit, afterRollback } from "@tranjs/core";

@Transactional()
async createOrder() {
    await ctx().query("INSERT ...");
    afterCommit(() => queue.publish("order.created"));
    afterRollback(() => metrics.increment("order.failed"));
}
```

- Hooks attach to the current physical transaction of the datasource (2nd argument, default datasource if omitted). Inside `NESTED`, they attach to the outer transaction.
- `afterCommit` hooks run sequentially in registration order after commit finishes. The first error stops later hooks and propagates to the caller, but the transaction remains committed. Core does not roll back or run `afterRollback` hooks, and calls `releaseTransaction(tx, false)` exactly once.
- `afterRollback` hooks run in registration order after rollback finishes. Their errors are logged and swallowed, allowing later hooks to run.
- With no active transaction, `afterCommit` runs the function immediately and `afterRollback` does nothing.

## Using Multiple Datasources

Register each manager under a name. Unnamed registration uses the default datasource.

```typescript
usePostgreSQLTransactionManager(primaryPool);              // default
usePostgreSQLTransactionManager(analyticsPool, "analytics");

class ReportService {
    @Transactional({ datasource: "analytics" })
    async build() {
        await ctx("analytics").query("SELECT ...");
    }
}
```

The same works with `useTransactionManager(manager, name)` and `getTransactionManager(name)`.

## Error Handling

- If an owning callback throws and rollback succeeds, **the original error** is rethrown. Joined failures mark rollback-only before rethrowing; catching one alone does not restore commit eligibility (a successful `NESTED` savepoint rollback clears the flag as described above).
- If an owner finishes normally but is rollback-only, it rolls back, runs `afterRollback` hooks, and throws `UnexpectedRollbackError`. Use `REQUIRES_NEW` for independent work, or `NESTED` for savepoint-isolated failures; do not catch joined failures expecting to commit.
- If rollback fails after an application error, timeout, or rollback-only decision, `TransactionSystemError` is thrown with message `"Transaction rollback failed after application error"`, `cause` containing the rollback error, and `applicationError` containing the original error (`TransactionTimeoutError` / `UnexpectedRollbackError` for those decisions). The original error is also logged via `manager.setLogger(logger)` (`console` by default). Rollback hooks still run.
- If `COMMIT` fails, core does **not** attempt rollback. It runs `afterRollback` hooks and rethrows the commit error; these hooks do not guarantee the database rolled back a failed commit. Native drivers dispose of the connection because its outcome may be uncertain. Do not blindly retry non-idempotent work.
- If an `afterCommit` hook fails, its error propagates without rollback or `afterRollback` hooks. The transaction is already committed and is released once with `failed=false`.
- Physical completion always calls the optional driver `releaseTransaction(tx, failed)` hook exactly once. Native drivers release on successful completion and dispose on failed commit/rollback.

## Exceptions

- **DatasourceSetupError**
    - Thrown when the requested datasource is not set up. Register it with `useTransactionManager()` or a driver's `use*TransactionManager()`.

- **IllegalTransactionStateException**
    - Thrown when the current transactional state violates the expected propagation rules.
    - Thrown for `MANDATORY` without a transaction, or `NEVER` inside one.

- **TransactionTimeoutError**
  - Thrown when a transaction exceeds its `timeout`. The transaction is rolled back.

- **UnexpectedRollbackError**
  - Thrown when a rollback-only transaction's owner attempts to commit after catching a joined failure (or a savepoint rollback failed). Also thrown when a `NESTED` callback returns while rollback-only; successful rollback to its savepoint clears the flag, so the outer callback may catch the error and commit, subject to the owner's deadline check.

- **TransactionSystemError**
  - Thrown when physical rollback fails; inspect `cause` and `applicationError` for both errors.

- **NestedTransactionNotSupportedError**
  - Thrown on `NESTED` inside a transaction when the manager does not implement savepoints.

- **NoTransactionContextError**
  - Thrown by the core `ctx()` when no transaction is active.

- **UnsupportedTransactionPropagationException**
  - Thrown when an unsupported propagation type is used.

- **TransactionContextMixingError**
  - Thrown mixed `ctx()` use when current transaction context is different from the one that started the transaction.
