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

## Isolation Level, Read-only, Timeout

```typescript
import { IsolationLevel } from "@tranjs/core";
```

`READ_UNCOMMITTED`, `READ_COMMITTED`, `REPEATABLE_READ`, `SERIALIZABLE`.

These options apply only when a new physical transaction begins (`REQUIRED` without an existing transaction, `REQUIRES_NEW`, `NESTED` without an existing transaction). A method that joins an existing transaction inherits its settings.

`timeout` (ms):
- After the method finishes, if more time has passed than `timeout`, the transaction is rolled back and `TransactionTimeoutError` is thrown instead of committing.
- The value is also passed to the driver. `@tranjs/pg` sets `SET LOCAL statement_timeout`; `@tranjs/mysql2` does not apply a DB-side timeout.

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
- They run in registration order after commit or rollback finishes. A hook that throws is logged and does not affect the result.
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

- If the method throws, the transaction is rolled back and **the original error** is rethrown. If the rollback also fails, the rollback error is sent to the manager's logger (`manager.setLogger(logger)`, `console` by default).
- If `COMMIT` fails, the driver rolls back and releases the connection; the commit error is thrown.

## Exceptions

- **DatasourceSetupError**
    - Thrown when the requested datasource is not set up. Register it with `useTransactionManager()` or a driver's `use*TransactionManager()`.

- **IllegalTransactionStateException**
    - Thrown when the current transactional state violates the expected propagation rules.
    - Thrown for `MANDATORY` without a transaction, or `NEVER` inside one.

- **TransactionTimeoutError**
  - Thrown when a transaction exceeds its `timeout`. The transaction is rolled back.

- **NestedTransactionNotSupportedError**
  - Thrown on `NESTED` inside a transaction when the manager does not implement savepoints.

- **NoTransactionContextError**
  - Thrown by the core `ctx()` when no transaction is active.

- **UnsupportedTransactionPropagationException**
  - Thrown when an unsupported propagation type is used.

- **TransactionContextMixingError**
  - Thrown mixed `ctx()` use when current transaction context is different from the one that started the transaction.