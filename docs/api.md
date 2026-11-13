# API

Reference for `@tranjs/core`: registration, transaction scopes, propagation, rollback rules, options, hooks, datasources and errors.

A *datasource* is a name (string or symbol) under which one transaction manager is registered; `DEFAULT_DATASOURCE` is used when no name is given. A *scope* is one call of a `@Transactional` method or `transactional` function. A *physical transaction* is one `BEGIN` to `COMMIT` or `ROLLBACK` on one connection; the scope that began it is its *owner*, and scopes that join it share it. The *bundled drivers* are `@tranjs/pg`, `@tranjs/postgres` and `@tranjs/mysql2`.

## Setup

Each datasource has one registered transaction manager. The bundled [drivers](drivers.md) provide registration helpers:

```typescript
// Example: registration for the default datasource (pg).
import { Pool } from "pg";
import { usePostgreSQLTransactionManager } from "@tranjs/pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
usePostgreSQLTransactionManager(pool);
```

Registration replaces the manager for that datasource process-wide. A transaction that began under the previous manager keeps running, and `ctx()` without a name still returns its connection. Lookups by datasource resolve the new manager: a transactional call made inside the old transaction does not join it (`REQUIRED` begins a separate transaction, `MANDATORY` throws `IllegalTransactionStateException`), `ctx(name)` throws `Error("Transaction context not initialized")`, and a hook given that name finds no transaction (see [Datasource selection](#datasource-selection)).

`useTransactionManager(manager, name?)` registers any manager, including a [custom driver](self-implement-guide.md)'s. Omitting the name selects the default datasource. `getTransactionManager(name?)` retrieves a registered manager.

`clearTransactionManager(name?)` removes the default or named manager registration and does nothing if none is registered. A transaction in progress still commits or rolls back, and `ctx()` without a name still returns its connection. From then on, lookups by datasource throw `DatasourceSetupError` until a manager is registered again: that covers transactional calls, `ctx(name)` and a hook given that name. A hook with the name omitted still registers on the transaction in progress.

```typescript
// Example: removing registrations.
import { clearTransactionManager } from "@tranjs/core";

clearTransactionManager(); // Default datasource.
clearTransactionManager("analytics"); // Named datasource; symbols are also accepted.
```

`getTransactionManager(name?).setLogger(logger)` replaces the default console logger for that manager. The `Logger` interface has four methods (`info`, `warn`, `error`, `debug`); TranJS calls only `error`.

## Transaction scopes

`@Transactional()` wraps an async method. It accepts either a `Propagation` value or a `TransactionConfig`. It preserves the method's `this`, name, and `reflect-metadata` metadata when that optional package is present, including when used with decorators such as NestJS's.

```typescript
// Example: @Transactional with a full config (pg).
// Assumes a registered pg manager and a users(name) table.
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

`transactional(fn, config?)` wraps a function and keeps its arguments and the `this` it is called with. The function can be synchronous or asynchronous. The wrapper always returns a Promise: it waits for the result and rejects if the call fails. It copies the configuration when it is created and looks up the manager on each call.

```typescript
// Signature of transactional().
function transactional<This, Args extends unknown[], R>(
    fn: (this: This, ...args: Args) => R, config?: Propagation | TransactionConfig,
): (this: This, ...args: Args) => Promise<Awaited<R>>;
```

```typescript
// Example: transactional() with a config (pg).
// Assumes a registered pg manager and a users(name) table.
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

The second argument can also be a `Propagation` value:

```typescript
// Example: transactional() with a Propagation value.
import { Propagation, transactional } from "@tranjs/core";

const isolated = transactional(() => 42, Propagation.REQUIRES_NEW);
```

`ctx(datasource?)` is exported by each driver package and returns the connection of the current transaction. [Datasource selection](#datasource-selection) describes which transaction it selects and what it throws; [connection lifetime](drivers.md#connection-lifetime) describes what the connection does after its transaction ends.

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

Propagation is tracked per datasource. A scope on datasource B never joins a transaction on datasource A. All bundled drivers support savepoints.

## Rollback rules

If a method throws, its transaction rolls back and the error is rethrown. Errors caught inside the same method don't affect the transaction.

If a method that joined an existing transaction (`REQUIRED`, `MANDATORY`, `SUPPORTS`) throws, the whole transaction is marked **rollback-only**. Catching the error in the outer method doesn't undo that: when the outer method returns, the transaction rolls back and `UnexpectedRollbackError` is thrown.

A failing `NESTED` scope rolls back to its savepoint. A successful savepoint rollback clears the **entire** rollback-only flag, including any flag set before that nested scope began. If a nested callback returns normally while rollback-only, core rolls back to the savepoint, clears the flag, and throws `UnexpectedRollbackError`. The outer callback may catch it and commit. A failed savepoint rollback is logged, leaves the transaction rollback-only, and preserves the original exception. Resetting rollback-only never extends the deadline; the owner still checks it before commit. Hooks registered in a `NESTED` scope follow its savepoint; see [Hooks](#hooks-in-nested-scopes).

`NESTED` scopes inside each other are allowed. Two at once in the same parent (for example with `Promise.all`) throw `ConcurrentNestedTransactionError`, because a connection has one savepoint stack.

`REQUIRES_NEW` runs in its own transaction. If its failure is caught, the outer transaction can still commit.

If physical rollback fails, `TransactionSystemError` preserves both failures; see [Errors](#errors). If commit fails, core does not attempt rollback: it runs `afterRollback` hooks and rethrows the commit error. The outcome may be uncertain, so those hooks do not guarantee that the database rolled back. The commit may have succeeded, so retrying work that is not idempotent can apply it twice.

After a failed commit or rollback, the `@tranjs/pg` and `@tranjs/mysql2` pool managers destroy the connection. `@tranjs/postgres` leaves it to postgres.js: 4.x closes a connection that is still in a transaction, 3.x returns it to the pool as it is. Per-transaction managers close their connections after completion.

## Isolation, readOnly, and timeout

These options apply only when a physical transaction begins: `REQUIRED` or `NESTED` without an existing transaction, or `REQUIRES_NEW`. Joined and savepoint scopes inherit the current transaction's settings.

`IsolationLevel` provides `READ_UNCOMMITTED`, `READ_COMMITTED`, `REPEATABLE_READ`, and `SERIALIZABLE`. The bundled drivers apply isolation and read-only settings with database SQL; see [driver setup and limitations](drivers.md).

### Deadlines

`timeout` must be finite, nonnegative, and at most `2147483647` ms. It establishes a physical transaction deadline that includes begin time. `REQUIRES_NEW` gets its own deadline. `timeout: 0` is accepted and expires at once: the transaction begins, the callback runs and the result is a rollback with `TransactionTimeoutError`.

The deadline is enforced by the connection that the driver's `ctx()` returns. Queries sent through a raw connection are not checked. Before each `pg` `query()` or `mysql2` `query()` / `execute()`, that connection checks the deadline. Expiry marks the transaction rollback-only and throws `TransactionTimeoutError` without dispatching the query.

For ordinary queries, it passes the **remaining** time as `pg`'s `query_timeout` or `mysql2`'s `timeout`. This overrides user per-query timeouts and pool defaults, even shorter ones. A timeout from that injected timer is translated to `TransactionTimeoutError`. Without a transaction deadline, user options are untouched.

`pg` Submittables (`pg.Query`, `pg-query-stream`, `pg-cursor`) are checked only before dispatch and passed through untouched. No per-query timeout is injected, and execution or stream events are not intercepted. A stream still open when the callback returns is not waited for; the commit proceeds.

With `pg` and `mysql2` these are client-side timeouts: the statement keeps running on the server. `@tranjs/postgres` sends a cancel request instead; see [drivers](drivers.md#postgresql-postgresjs). TranJS does not set `statement_timeout`. A running statement can finish before queued rollback completes, so completion can take longer than the deadline. The deadline does not interrupt arbitrary JavaScript or other I/O. Core checks it again after the callback, before commit. A rollback failure takes precedence as `TransactionSystemError`.

## Hooks

```typescript
// Example: hooks registered inside a transaction (pg).
// Assumes a registered pg manager and an orders(id) table.
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

```typescript
// Signatures of the hooks. TransactionSynchronization is exported by @tranjs/core.
type TransactionSynchronization = () => void | Promise<void>;
function afterCommit(fn: TransactionSynchronization, datasource?: string | symbol): void | Promise<void>;
function afterRollback(fn: TransactionSynchronization, datasource?: string | symbol): void | Promise<void>;
```

`afterCommit(fn, datasource?)` and `afterRollback(fn, datasource?)` accept synchronous or async callbacks. Each call selects one transaction, and what the call does depends on the state of that transaction. [Datasource selection](#datasource-selection) describes which transaction an omitted or explicit `datasource` selects. A hook is never moved to another transaction.

| State of the selected transaction | `afterCommit(fn)` | `afterRollback(fn)` |
|---|---|---|
| None selected | Calls `fn` immediately and returns its result | Does nothing |
| In progress, including while it is committing or rolling back | Calls `fn` after it commits | Calls `fn` after it rolls back, or after its commit or rollback fails |
| Committed | Calls `fn` immediately and returns its result | Does nothing |
| Rolled back, or its commit or rollback failed | Does nothing | Calls `fn` immediately |

The last two rows apply to work that outlives the transaction it started in, such as a timer or a promise that was not awaited.

Hooks registered on a transaction in progress run when it completes:

| Hook | Behavior |
|---|---|
| `afterCommit` | Runs sequentially in registration order after successful commit. The first error stops later hooks and propagates to the caller of the transaction. The transaction remains committed; no rollback or `afterRollback` hooks run. |
| `afterRollback` | Runs sequentially in registration order after rollback, including failed rollback, or after failed commit. Errors are logged through the manager's logger and swallowed, so later hooks still run. |

`afterRollback` callbacks also run when a commit or rollback fails. That they ran does not establish that the database rolled back; see [rollback rules](#rollback-rules).

A call that registers `fn`, or does nothing, returns `undefined`. When `afterCommit` calls `fn` immediately, it returns what `fn` returns, and an error from `fn` reaches the caller of `afterCommit`. When `afterRollback` calls `fn` immediately, it returns a promise that resolves once `fn` has finished. An error from `fn` is logged through the manager's logger and the promise does not reject, so a call that is not awaited causes no unhandled rejection.

While a transaction's hooks run after its commit or rollback, that transaction is suspended for them. A hook registered inside one of them cannot select the completing transaction, by name or with the name omitted. The selection rules apply as anywhere else: they find a transaction on another datasource, or none, and the table above applies to what they find.

By the time a hook runs after commit or rollback, the completing transaction is finished and its connection rejects queries. An enclosing transaction on another datasource stays visible inside the hook, and `ctx()` with the name omitted selects its connection. A query sent through that connection is part of the enclosing transaction and commits or rolls back with it.

A hook that awaits a new transaction on the same pool as the completing transaction needs a second connection: the completing connection goes back to the pool only after the hooks return. That holds for `afterCommit` and `afterRollback` hooks alike. With a pool of one connection, the new transaction waits for a connection that is released only when the hook returns, so the hook never returns and the transactional call never settles. A pool with an acquire timeout, such as `pg`'s `connectionTimeoutMillis`, ends the wait with its own error. From an `afterCommit` hook that error reaches the caller of the transaction. From an `afterRollback` hook it is logged, and the caller receives the error that caused the rollback.

To require a transaction, register the hook from a function declared with `Propagation.MANDATORY`. Unless a transaction on its datasource is in progress, that function rejects with `IllegalTransactionStateException` and the hook is never registered. That includes a call from work that outlived the transaction.

### Hooks in NESTED scopes

Joined scopes (`REQUIRED`, `MANDATORY`, `SUPPORTS`) register on the transaction they joined. In a `NESTED` scope, hooks follow the savepoint:

| The `NESTED` scope | Its `afterCommit` hooks | Its `afterRollback` hooks |
|---|---|---|
| Rolls back to its savepoint | Discarded | Run at that point, before the nested call rejects and while the enclosing transaction is still open. They do not run again if that transaction later rolls back. |
| Ends any other way | Pass to the enclosing scope when the nested call ends, and are handled from then on as hooks registered there | The same |

When the enclosing scope is the transaction's own, the hooks run when the transaction completes. When it is another `NESTED` scope, they follow that scope's savepoint in turn. A failed savepoint rollback belongs to the second row: the hooks pass to the enclosing scope, and the transaction is rollback-only.

An `afterRollback` hook that runs at a savepoint rollback runs inside the enclosing transaction, so `ctx()` returns that transaction's connection there, and a hook registered inside it registers on the enclosing scope. Its errors are logged and swallowed, like those of any `afterRollback` hook.

A hook registered from work that kept the async context of a `NESTED` scope that has ended follows that scope. After a savepoint rollback, `afterRollback` calls `fn` immediately and `afterCommit` does nothing. Otherwise the hook is handled as one registered in the enclosing scope.

A `NESTED` scope can still be open when its enclosing transaction finishes, if the nested call was not awaited. That call rejects with `TransactionClosedError`. Its hooks then run when it ends, by the outcome of the enclosing transaction, and errors from both kinds are logged.

## Multiple datasources

A manager can be registered under a string or symbol name. A transaction selects its datasource through `datasource` in the transaction config and uses the default datasource without one.

```typescript
// Example: a default and a named datasource (pg). The env var names are illustrative.
import { Transactional } from "@tranjs/core";
import { ctx, usePostgreSQLTransactionManager } from "@tranjs/pg";
import { Pool } from "pg";

const primaryPool = new Pool({ connectionString: process.env.DATABASE_URL });
const analyticsPool = new Pool({ connectionString: process.env.ANALYTICS_URL });
usePostgreSQLTransactionManager(primaryPool);
usePostgreSQLTransactionManager(analyticsPool, "analytics");

class ReportService {
    @Transactional({ datasource: "analytics" })
    async build() {
        // ctx() selects the analytics transaction here (@tranjs/pg 1.4.0 or later).
        // ctx("analytics") is equivalent.
        return ctx().query("SELECT 1");
    }
}
```

### Datasource selection

The transaction config, `ctx()` and the hooks each take an optional datasource and resolve it on their own:

| Call | Datasource omitted | Datasource given |
|---|---|---|
| `@Transactional` / `transactional` config | The default datasource | The manager registered under that name |
| `ctx()` | The innermost transaction in the current async context, whatever its datasource | The transaction of the manager registered under that name in the current async context |
| `afterCommit` / `afterRollback` | The innermost transaction in the current async context, whatever its datasource | The transaction of the manager registered under that name in the current async context |

When transactions on two datasources are nested, the inner one is selected, in either nesting order: `ctx()` returns its connection and hooks register on it. An explicit name selects that datasource's transaction, including an outer one.

The selection does not skip a transaction that has finished. Work that kept the async context of a finished transaction still selects it: `ctx()` throws `TransactionClosedError`, and a hook acts on its outcome. Neither falls back to an outer transaction that is still in progress.

`ctx()` throws in these cases:

| Case | Error |
|---|---|
| The selected manager belongs to another driver, for example `ctx()` from `@tranjs/pg` when the innermost transaction is a `@tranjs/mysql2` one | `TransactionContextMixingError` |
| Name omitted, no active transaction, no default registration | `DatasourceSetupError` |
| Name omitted, no active transaction, default registration present | `Error("Transaction context not initialized")` |
| Name given, no manager registered under it | `DatasourceSetupError` |
| Name given, its manager has no active transaction | `Error("Transaction context not initialized")` |
| Called from work that kept the async context of a completed inner transaction, with the name omitted or naming that transaction's datasource | `TransactionClosedError`, even while an outer transaction is still active. `ctx()` does not fall back to the outer connection. |

"No active transaction" includes `SUPPORTS`, `NOT_SUPPORTED` and `NEVER` scopes that run without one. A transaction suspended by `NOT_SUPPORTED` or `REQUIRES_NEW` is not selected inside that scope. Inside `REQUIRES_NEW` the new transaction is selected in its place. Inside `NOT_SUPPORTED`, a lookup by name finds no transaction, and a lookup with the name omitted selects the next transaction out on another datasource, if there is one. A transaction on another datasource is not suspended by the scope and still counts.

The hooks throw in one case: a name with no registered manager throws `DatasourceSetupError`, inside or outside a transaction. Otherwise they follow the state of the selected transaction, as the table under [Hooks](#hooks) describes. When nothing is selected, `afterCommit` calls the callback immediately and `afterRollback` does nothing. That covers an explicit name whose manager has no transaction in the current async context.

A hook registered from work that kept the async context of a finished transaction acts on that transaction's outcome, with the name omitted or naming its datasource. That holds while an outer transaction is still in progress, whether the outer one is on another datasource or was suspended by `REQUIRES_NEW`: the hook is not moved to it.

See the [changelog](../CHANGELOG.md) for release behavior changes and migration notes.

## Testing helpers

| Entry point | Exports |
|---|---|
| `@tranjs/testing` | `withTestTransaction`, `mockTransactions`, `currentProbe`, `withTestConnection`, `matchers`; types: `TestOptions`, `TestTransactionProbe`, `TestTransactionRecord`, `TestFailureSelector`; assertions: `assertSameTransaction`, `assertSeparateTransaction`, `assertOutsideTransaction`, `assertAfterCommitOf`, `assertCommitted`, `assertRolledBack` |
| `@tranjs/testing/jest` | Registers six matchers with Jest's `expect`; exports `matchers` and matcher types |
| `@tranjs/testing/vitest` | Registers six matchers with Vitest's `expect`; exports `matchers` and matcher types |
| `@tranjs/pg`, `@tranjs/mysql2`, `@tranjs/postgres` | Each exports its own `TestConnection` type for `withTestConnection` |

See the testing guide for the [example setup](testing.md#example-setup) and [checking transaction boundaries](testing.md#checking-boundaries).

`@tranjs/core` does not depend on `@tranjs/testing`, and its test hooks do nothing until a helper runs.

## Errors

All classes are exported by `@tranjs/core` except where a driver package is named.

| Class | When thrown | Notes |
|---|---|---|
| `TransactionSystemError` | Physical rollback fails | Message: `"Transaction rollback failed after application error"`. `cause` is the rollback error; `applicationError` is the original exception, timeout, or rollback-only decision. The original error is also logged. |
| `UnexpectedRollbackError` | An owner or `NESTED` callback returns while rollback-only | See [rollback rules](#rollback-rules) for savepoint reset behavior. |
| `TransactionTimeoutError` | A transaction deadline expires or its injected query timer fires | Marks rollback-only; physical rollback can replace it with `TransactionSystemError`. |
| `TransactionClosedError` | `ctx()` or a connection from it is used after its transaction or test ended | See [connection lifetime](drivers.md#connection-lifetime). |
| `InvalidIsolationLevelError` | A new physical transaction receives an invalid isolation level | Extends `TypeError`; validation happens before begin. |
| `ConcurrentNestedTransactionError` | A sibling `NESTED` scope is still open in the same parent scope | Nested scopes inside each other are allowed. |
| `NestedTransactionNotSupportedError` | A manager without savepoint support receives `NESTED` inside a transaction | Extends `UnsupportedTransactionPropagationException`. |
| `DatasourceSetupError` | The requested datasource has no registered manager | Its `.name` is `"TransactionDatasourceSetupError"`. |
| `IllegalTransactionStateException` | `MANDATORY` has no transaction, or `NEVER` has one | Propagation constraint violation. |
| `TransactionContextMixingError` | A bundled driver's `ctx()` selects a manager of another driver | The message names the selected manager's class and the calling driver. See [Datasource selection](#datasource-selection). |
| `TransactionAbortedError` (`@tranjs/pg`, `@tranjs/postgres`) | PostgreSQL rolls back a `COMMIT` because a query in the transaction failed | `afterRollback` hooks run. Nothing from the transaction was saved. Each package exports its own class, so `instanceof` does not cross packages. |
| `NoTransactionContextError` | The deprecated core `ctx()` has no active context | A bundled driver's `ctx()` instead throws `Error("Transaction context not initialized")` when the selected manager has no active transaction. |
| `UnsupportedTransactionPropagationException` | An unsupported propagation value is passed | The message lists the supported values. |
| `UnsupportedIsolationLevelError` (`@tranjs/mysql2`) | Connection-per-transaction mode receives an explicit isolation level with its default rejection policy | Rejected before connecting; exposes `isolationLevel`. See [Hyperdrive limitations](drivers.md#hyperdrive-with-mysql2). |
| `RangeError` (built-in) | A new physical transaction receives an invalid timeout | See [deadline limits](#deadlines). |
