# Drivers

Setup, connection types and limits of the bundled drivers: `@tranjs/pg`, `@tranjs/postgres` and `@tranjs/mysql2`.

## PostgreSQL (pg)

```bash
# @tranjs/pg with pg
npm install @tranjs/core @tranjs/pg pg
```

`usePostgreSQLTransactionManager(pool, name?)` creates the manager and registers it; no separate `useTransactionManager` call is involved.

```typescript
// Example: pool mode (pg). The env var name is illustrative.
import { Transactional } from "@tranjs/core";
import { ctx, usePostgreSQLTransactionManager } from "@tranjs/pg";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
usePostgreSQLTransactionManager(pool);

class Service {
    @Transactional()
    async read() {
        return ctx().query("SELECT 1");
    }
}
```

`ctx(datasource?)` returns the connection of the current transaction; see [datasource selection](api.md#datasource-selection) for which transaction that is. Its exported `PoolClient` type omits `connect` and `release` from `pg.PoolClient`. `TransactionClient` (`pg.Client` without `connect`) is a type that fits both the pool and per-transaction connection. The types omit `release` and `connect`, but they are still reachable from JavaScript or through a cast. Calling `release()` returns the connection to the pool while its transaction is still open.

Isolation uses `BEGIN ISOLATION LEVEL …`; read-only uses `BEGIN … READ ONLY`. Savepoints and named datasources are supported. See [transaction options and deadlines](api.md#isolation-readonly-and-timeout), including the special handling of `pg` Submittables.

If a query fails inside a transaction, PostgreSQL aborts the transaction, even when the code catches the error. The later `COMMIT` is turned into a rollback, and TranJS throws `TransactionAbortedError` (exported by `@tranjs/pg`) so the failure isn't silent. A step that is allowed to fail survives in a scope of its own: `Propagation.NESTED` (savepoint on the same connection) or `Propagation.REQUIRES_NEW` (separate transaction and connection). The error has to be caught outside that scope, so the scope rolls back first.

## PostgreSQL (postgres.js)

```bash
# @tranjs/postgres with postgres.js
npm install @tranjs/core @tranjs/postgres postgres
```

Works with postgres.js `^3.4.0 || ^4.1.0` on Node.js 18 or later. `usePostgresTransactionManager(sql, name?)` takes a `postgres()` instance:

```typescript
// Example: pool mode (postgres.js). The env var name is illustrative.
import { Transactional } from "@tranjs/core";
import { ctx, usePostgresTransactionManager } from "@tranjs/postgres";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!);
usePostgresTransactionManager(sql);

class Service {
    @Transactional()
    async read() {
        return ctx()`SELECT 1`;
    }
}
```

`ctx(datasource?)` returns the connection reserved for the current transaction, typed as `TransactionSql`; see [datasource selection](api.md#datasource-selection) for which transaction that is. Queries are written as on any postgres.js connection (``ctx()`SELECT ...` `` or `ctx().unsafe(...)`). Custom types are preserved on both `typed` and its `types` alias; `ctx<T>()` and `TransactionSql<T>` carry the custom types of the registered instance, for example `ctx<{ bigint: bigint }>()`.

TranJS releases the connection when the transaction ends. `release`, `begin`, `reserve`, `end`, `close`, `listen`, `subscribe`, `largeObject` and the dispose methods are typed `never` and are `undefined` at runtime, so `ctx().listen` is not available and `using` on `ctx()` is a compile error.

`new PostgresTransactionManager(sql)` passed to `useTransactionManager` is equivalent to the helper. Both take an optional datasource name as their second argument.

A failed query aborts the transaction in the same way as described for [pg](#postgresql-pg). `@tranjs/postgres` exports its own `TransactionAbortedError`.

postgres.js has no per-query timeout, so a transaction `timeout` is enforced by canceling the running query when the deadline passes; this surfaces as `TransactionTimeoutError`. Batch queries have the same deadline checks at construction and first execution, and the same cancellation behavior, as normal queries. `cursor()`, `forEach()`, `stream()` and `readable()` are only checked before they start and are not canceled mid-way. One still running when the callback returns is not waited for.

postgres.js 3.x has no `batch()` or instance `query_timeout` option. TranJS adds no postgres.js options in pool mode. Per-transaction mode sets `max: 1`.

Connection loss is handled by postgres.js itself. With 3.x, a query sent on a connection that has already dropped can throw an uncaught error inside postgres.js; 4.x rejects it with `CONNECTION_CLOSED`.

After a failed commit or rollback, `@tranjs/postgres` releases the reserved connection and leaves the rest to postgres.js. 4.x closes a connection that is still in a transaction. 3.x returns it to the pool as it is, so the next user of that connection can start inside the unfinished transaction.

The built CommonJS package works on Node.js 18, 20.10 and 22 without `require(ESM)` support. postgres.js 4.x is published as ES modules only; a CommonJS application that creates its own pool can load it with `const { default: postgres } = await import("postgres")` inside an async function.

## MySQL (mysql2)

```bash
# @tranjs/mysql2 with mysql2
npm install @tranjs/core @tranjs/mysql2 mysql2
```

`useMySQLTransactionManager(pool, name?)` takes a `mysql2/promise` pool. A callback-API pool does not fit its type.

```typescript
// Example: pool mode (mysql2). The connection settings are illustrative.
import { Transactional } from "@tranjs/core";
import { ctx, useMySQLTransactionManager } from "@tranjs/mysql2";
import { createPool } from "mysql2/promise";

const pool = createPool({ host: "localhost", user: "root", database: "test" });
useMySQLTransactionManager(pool);

class Service {
    @Transactional()
    async read() {
        return ctx().execute("SELECT 1");
    }
}
```

`ctx(datasource?)` returns the connection of the current transaction; see [datasource selection](api.md#datasource-selection) for which transaction that is. Its exported `PoolConnection` type omits `connect`, `end`, `destroy`, `beginTransaction`, `release`, `commit`, and `rollback` from `mysql2/promise.PoolConnection`. `TransactionConnection` is a type that fits both connection modes; it omits the same lifecycle methods, except `release`, from `mysql2/promise.Connection`. TranJS owns those lifecycle operations.

The pool manager applies isolation with `SET TRANSACTION ISOLATION LEVEL …`, then starts with `START TRANSACTION` or `START TRANSACTION READ ONLY`. Savepoints and named datasources are supported. See [transaction options and deadlines](api.md#isolation-readonly-and-timeout); connection-per-transaction isolation has the [policy below](#hyperdrive-with-mysql2).

## Connection lifetime

The connection `ctx()` returns is a wrapper around the driver's connection. It forwards calls to the driver and adds the checks described here and the [deadline checks](api.md#deadlines).

After a transaction or test ends, `ctx()` throws `TransactionClosedError` (exported by `@tranjs/core`) when called from work that outlived it. That holds while an outer transaction is still active: `ctx()` does not fall back to the outer connection (see [datasource selection](api.md#datasource-selection)). A connection kept from `ctx()` throws the same error when a query is run through it, and so do methods taken from it or bound. The error is thrown before the query is passed to the driver.

The check needs `@tranjs/core` 1.2.0 with `@tranjs/pg` 1.3.0, `@tranjs/mysql2` 1.3.0 or `@tranjs/postgres` 1.2.0. Earlier versions ran these queries on a connection that had already gone back to the pool. Before `@tranjs/pg` 1.4.0, `@tranjs/mysql2` 1.4.0 and `@tranjs/postgres` 1.3.0, `ctx()` without a name always means the default datasource. The [selection across datasources](api.md#datasource-selection) needs one of those versions, each of which needs `@tranjs/core` 1.3.0.

`afterCommit` and `afterRollback` do not throw for a finished transaction. They act on its outcome; see [hooks](api.md#hooks).

A query already sent to the database can finish before cleanup. `withTestTransaction` does not wait for calls that were not awaited. TranJS does not detect a missing `await`. A lint rule such as `@typescript-eslint/no-floating-promises` is one way to catch it.

Joined calls and `NESTED` scopes share their parent's connection from `ctx()`, which stays usable until that transaction ends. `REQUIRES_NEW` has its own connection from `ctx()` that stops working when the child transaction ends, even in tests where both use the same physical connection. The connection passed to a `withTestConnection` callback stops working when that callback or its enclosing test ends.

The check covers the connection `ctx()` returns and its own query methods. It does not cover objects the driver hands out itself: the `this` of an event listener, properties (for example `pg`'s `connection`), the internals of a query or command object, or the raw connection from `manager.getCurrentTransaction()`. A query sent through any of these after the transaction ends can run outside a transaction, or inside whichever transaction holds that pooled connection next.

Nothing stops `BEGIN`, `COMMIT` or `ROLLBACK` sent as SQL through `ctx()`, with any of the three drivers. TranJS does not see them, so its own commit, rollback and hooks then act on a transaction that has already ended or changed.

## Supported runtimes

Node.js, Bun, Deno, AWS Lambda and Vercel Functions (Node.js runtime) use pool mode, as in the sections above. Cloudflare Workers use [connection-per-transaction mode with Hyperdrive](#cloudflare-workers--hyperdrive). Runtimes without TCP sockets are not supported. The README has the [platform table](../README.md#supported-platforms).

## Cloudflare Workers + Hyperdrive

TranJS and the drivers need the [`nodejs_compat`](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) flag. Registration at module scope runs once per isolate; see [Setup](api.md#setup) for what re-registration per request does. The examples assume a Hyperdrive binding named `HYPERDRIVE`.

Connection-per-transaction managers do not share an application-side pool between transactions. Each physical transaction resolves its configuration, opens a connection, and calls `end()` automatically on completion, including failures. `transactional`, `@Transactional` and `ctx()` behave as in pool mode. Joined and `NESTED` scopes reuse the connection; `REQUIRES_NEW` opens another. Outside Hyperdrive each transaction pays for a new connection; the pool managers reuse them.

### Hyperdrive with pg

Needs `pg` 8.16.3 or later, the [minimum Cloudflare lists for Hyperdrive](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/node-postgres/):

```typescript
// Example: Cloudflare Workers + Hyperdrive (pg).
// Assumes a Hyperdrive binding named HYPERDRIVE.
import { env } from "cloudflare:workers";
import { usePostgreSQLClientPerTransaction } from "@tranjs/pg";

usePostgreSQLClientPerTransaction(() => ({
    connectionString: env.HYPERDRIVE.connectionString,
}));
```

This manager creates a fresh `pg.Client`, not a `pg.Pool`. `new PostgreSQLClientPerTransactionManager(config)` passed to `useTransactionManager` is equivalent. Both the pool and per-transaction registration helpers accept an optional datasource name as their second argument.

[Hyperdrive uses transaction-mode pooling](https://developers.cloudflare.com/hyperdrive/configuration/connection-pooling/). Session state cannot be relied on between transactions:

| Limitation | Alternative |
|---|---|
| `SET` outside a transaction does not persist | Transaction-local settings inside the transaction |
| No session advisory locks | Transaction-scoped advisory locks |
| No `LISTEN` / `NOTIFY` | Another messaging mechanism |
| No SQL `PREPARE` | Queries without SQL-level preparation |

### Hyperdrive with postgres.js

```typescript
// Example: Cloudflare Workers + Hyperdrive (postgres.js).
// Assumes a Hyperdrive binding named HYPERDRIVE.
import { env } from "cloudflare:workers";
import { usePostgresConnectionPerTransaction } from "@tranjs/postgres";

usePostgresConnectionPerTransaction(() => env.HYPERDRIVE.connectionString);
```

The argument can be a connection string, postgres.js options, or a function returning either. Each transaction opens its own connection and closes it when the transaction ends. The same Hyperdrive session-state limits as for `pg` apply: no `SET` outside a transaction, no session advisory locks, no `LISTEN`/`NOTIFY`, no SQL `PREPARE`.

Loading `@tranjs/postgres` does not load postgres.js. Connection-per-transaction mode loads it on first use with `import("postgres")`, which stays visible to bundlers so they can select postgres.js's `workerd` export for Workers.

### Hyperdrive with mysql2

Needs `mysql2` 3.13.0 or later with `disableEval: true`, both of which [Cloudflare lists as required](https://developers.cloudflare.com/hyperdrive/examples/connect-to-mysql/mysql-drivers-and-libraries/mysql2/) for `mysql2` on Workers:

```typescript
// Example: Cloudflare Workers + Hyperdrive (mysql2).
// Assumes a Hyperdrive binding named HYPERDRIVE.
import { env } from "cloudflare:workers";
import { useMySQLConnectionPerTransaction } from "@tranjs/mysql2";

useMySQLConnectionPerTransaction(() => ({
    host: env.HYPERDRIVE.host,
    user: env.HYPERDRIVE.user,
    password: env.HYPERDRIVE.password,
    database: env.HYPERDRIVE.database,
    port: env.HYPERDRIVE.port,
    disableEval: true,
}));
```

Hyperdrive limits what MySQL can do:

| Limitation | Result |
|---|---|
| Isolation levels are ignored without an error, and this can't be detected at runtime | This mode rejects an explicit `isolationLevel` with `UnsupportedIsolationLevelError` before connecting. Without one, the server default (usually `REPEATABLE READ`) applies. |
| A write in a `readOnly` transaction drops the connection instead of returning a MySQL error | The write is still blocked. The error is `TransactionSystemError` with `PROTOCOL_CONNECTION_LOST` in `applicationError`. |
| Prepared statements aren't supported | `ctx().execute()` fails; `ctx().query()` works. |
| No multi-statement queries | One statement per query. |
| No `USE` | The database comes from the connection config. |

`isolationLevelSupport: "apply"` sends the isolation statement. It is meant for direct MySQL connections: through Hyperdrive the statement is ignored without an error and the transaction runs at the server default.

```typescript
// Direct MySQL connections only. Through Hyperdrive the isolation statement is ignored without an error.
import { useMySQLConnectionPerTransaction } from "@tranjs/mysql2";

const config = { host: "localhost", user: "root", database: "test" };
useMySQLConnectionPerTransaction(config, undefined, {
    isolationLevelSupport: "apply",
});
```

The helper accepts `(config, name?, options?)`; direct construction uses `new MySQLConnectionPerTransactionManager(config, options?)`. `isolationLevelSupport: "reject"` is the default. `"apply"` sends `SET TRANSACTION ISOLATION LEVEL` followed by `START TRANSACTION`. This policy does not affect the pool manager.
