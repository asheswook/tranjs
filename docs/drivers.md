# Drivers

## PostgreSQL (pg)

```bash
npm install @tranjs/core @tranjs/pg pg
```

Register a pool at module scope. `usePostgreSQLTransactionManager` registers the manager for you; no separate `useTransactionManager` call is needed.

```typescript
import { Transactional } from "@tranjs/core";
import { ctx, usePostgreSQLTransactionManager } from "@tranjs/pg";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.PG_URL });
usePostgreSQLTransactionManager(pool);

class Service {
    @Transactional()
    async read() {
        return ctx().query("SELECT 1");
    }
}
```

`ctx(datasource?)` returns the active transaction's wrapped connection. Its exported `PoolClient` type omits `connect` and `release` from `pg.PoolClient`. For helpers that accept either pool or per-transaction mode, use the exported `TransactionClient` type (`pg.Client` without `connect`). TranJS owns connection completion and cleanup; do not call lifecycle methods yourself.

Isolation uses `BEGIN ISOLATION LEVEL …`; read-only uses `BEGIN … READ ONLY`. Savepoints and named datasources are supported.

If a query fails inside a transaction, PostgreSQL aborts the transaction, even when your code catches the error. The later `COMMIT` is turned into a rollback, and TranJS throws `TransactionAbortedError` (exported by `@tranjs/pg`) so the failure isn't silent. Use `Propagation.NESTED` if a step should be allowed to fail. See [transaction options and deadlines](api.md#isolation-readonly-and-timeout), including the special handling of PostgreSQL Submittables.

## PostgreSQL (postgres.js)

```bash
npm install @tranjs/core @tranjs/postgres postgres
```

Requires postgres.js `^3.4.0 || ^4.1.0`. Create one `postgres()` instance at startup and register it:

```typescript
import { Transactional } from "@tranjs/core";
import { ctx, usePostgresTransactionManager } from "@tranjs/postgres";
import postgres from "postgres";

const sql = postgres(process.env.PG_URL!);
usePostgresTransactionManager(sql);

class Service {
    @Transactional()
    async read() {
        return ctx()`SELECT 1`;
    }
}
```

`ctx(datasource?)` returns the connection reserved for the current transaction, typed as `TransactionSql`. Write queries on it as usual (``ctx()`SELECT ...` `` or `ctx().unsafe(...)`). Custom types are preserved on both `typed` and its `types` alias; use `ctx<{ bigint: bigint }>()` or `TransactionSql<{ bigint: bigint }>` when the registered connection has that custom type. TranJS releases the connection when the transaction ends, so `ctx()` has no `release()`, `begin()` or dispose methods (don't use it with `using`). Don't send `BEGIN`, `COMMIT` or `ROLLBACK` yourself either.

For direct registration, pass `new PostgresTransactionManager(sql)` to `useTransactionManager`. Both registration helpers accept an optional datasource name as their second argument.

If a query fails inside a transaction, PostgreSQL aborts the transaction, even when your code catches the error. The later `COMMIT` is turned into a rollback, and TranJS throws `TransactionAbortedError` so the failure isn't silent. Use `Propagation.NESTED` if a step should be allowed to fail.

postgres.js has no per-query timeout, so a transaction `timeout` is enforced by cancelling the running query when the deadline passes; this surfaces as `TransactionTimeoutError`. Batch queries have the same deadline checks at construction and first execution, and the same cancellation behavior, as normal queries. `cursor()`, `forEach()`, `stream()` and `readable()` are only checked before they start and are not cancelled mid-way. Finish them inside the transaction.

postgres.js 3.x has no `batch()` or instance `query_timeout` option. Your own supported postgres.js options are left as they are.

Connection loss is handled by postgres.js itself. With 3.x, a query sent on a connection that has already dropped can throw an uncaught error inside postgres.js; 4.x rejects it with `CONNECTION_CLOSED`.

## MySQL (mysql2)

```bash
npm install @tranjs/core @tranjs/mysql2 mysql2
```

Use a pool from `mysql2/promise`. `useMySQLTransactionManager` registers the manager at module scope.

```typescript
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

`ctx(datasource?)` returns the active transaction's wrapped connection. Its exported `PoolConnection` type omits `connect`, `end`, `destroy`, `beginTransaction`, `release`, `commit`, and `rollback` from `mysql2/promise.PoolConnection`. Use the exported `TransactionConnection` type for helpers accepting either connection mode; it omits the same lifecycle methods, except `release`, from `mysql2/promise.Connection`. TranJS owns those lifecycle operations.

The pool manager applies isolation with `SET TRANSACTION ISOLATION LEVEL …`, then starts with `START TRANSACTION` or `START TRANSACTION READ ONLY`. Savepoints and named datasources are supported. See [transaction options and deadlines](api.md#isolation-readonly-and-timeout); connection-per-transaction isolation has the [policy below](#mysql).

## Supported runtimes

| Runtime | Setup |
|---|---|
| Node.js | Pool mode |
| Bun | Pool mode |
| Deno | Pool mode, imported with `npm:` specifiers. Set `"experimentalDecorators": true` in `deno.json` to use `@Transactional`. |
| AWS Lambda, Vercel Functions (Node.js runtime) | Pool mode, registered once at module scope |
| Cloudflare Workers | [Connection-per-transaction mode with Hyperdrive](#cloudflare-workers--hyperdrive) |
| Runtimes without TCP sockets (e.g. Vercel Edge) | Not supported |

## Cloudflare Workers + Hyperdrive

Enable [`nodejs_compat`](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) in the Worker configuration and register once at module scope, not in the request handler. The examples assume a Hyperdrive binding named `HYPERDRIVE`.

Connection-per-transaction managers do not share an application-side pool between transactions. Each physical transaction resolves its configuration, opens a connection, and calls `end()` automatically on completion, including failures. Use `runInTransaction` / `@Transactional` and the driver's `ctx()` as usual. Joined and `NESTED` scopes reuse the connection; `REQUIRES_NEW` opens another. On Node without Hyperdrive, prefer the pool managers to reuse connections.

### PostgreSQL

Use `pg >= 8.16.3`:

```typescript
import { env } from "cloudflare:workers";
import { usePostgreSQLClientPerTransaction } from "@tranjs/pg";

usePostgreSQLClientPerTransaction(() => ({
    connectionString: env.HYPERDRIVE.connectionString,
}));
```

This manager creates a fresh `pg.Client`, not a `pg.Pool`. For direct registration, pass `new PostgreSQLClientPerTransactionManager(config)` to `useTransactionManager`. Both the pool and per-transaction registration helpers accept an optional datasource name as their second argument.

[Hyperdrive uses transaction-mode pooling](https://developers.cloudflare.com/hyperdrive/configuration/connection-pooling/). Session state cannot be relied on between transactions:

| Limitation | What to use instead |
|---|---|
| `SET` outside a transaction does not persist | Transaction-local settings inside the transaction |
| No session advisory locks | Transaction-scoped advisory locks |
| No `LISTEN` / `NOTIFY` | Another messaging mechanism |
| No SQL `PREPARE` | Queries without SQL-level preparation |

### PostgreSQL (postgres.js)

```typescript
import { env } from "cloudflare:workers";
import { usePostgresConnectionPerTransaction } from "@tranjs/postgres";

usePostgresConnectionPerTransaction(() => env.HYPERDRIVE.connectionString);
```

The argument can be a connection string, postgres.js options, or a function returning either. Each transaction opens its own connection and closes it when the transaction ends. The same Hyperdrive session-state limits as for `pg` apply: no `SET` outside a transaction, no session advisory locks, no `LISTEN`/`NOTIFY`, no SQL `PREPARE`.

The built CommonJS package works on Node.js 18, 20.10 and 22 without `require(ESM)` support. Loading the package does not load postgres.js; connection-per-transaction mode lazily loads and caches it with native `import("postgres")`. The import remains visible to bundlers so they can select postgres.js's `workerd` export for Workers; no `eval` or generated function is used. CommonJS applications creating their own pool can use `const { default: postgres } = await import("postgres")` inside an async function.

### MySQL

Use `mysql2 >= 3.13.0` with `disableEval: true`:

```typescript
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

| Limitation | What to do |
|---|---|
| Isolation levels are ignored without an error, and this can't be detected at runtime | This mode rejects an explicit `isolationLevel` with `UnsupportedIsolationLevelError` before connecting. Without one, the server default (usually `REPEATABLE READ`) applies. |
| A write in a `readOnly` transaction drops the connection instead of returning a MySQL error | The write is still blocked. The error is `TransactionSystemError` with `PROTOCOL_CONNECTION_LOST` in `applicationError`. |
| Prepared statements aren't supported | Use `ctx().query()`, not `ctx().execute()`. |
| No multi-statement queries | Send statements separately. |
| No `USE` | Set the database in the connection config. |

For **direct MySQL connections only**, opt into applying isolation settings:

```typescript
import { useMySQLConnectionPerTransaction } from "@tranjs/mysql2";

const config = { host: "localhost", user: "root", database: "test" };
useMySQLConnectionPerTransaction(config, undefined, {
    isolationLevelSupport: "apply",
});
```

The helper accepts `(config, name?, options?)`; direct construction uses `new MySQLConnectionPerTransactionManager(config, options?)`. `isolationLevelSupport: "reject"` is the default. `"apply"` sends `SET TRANSACTION ISOLATION LEVEL` followed by `START TRANSACTION`. Do not enable it through Hyperdrive. This policy does not affect the pool manager.

## Development

Driver tests use real databases. From the repository root:

```bash
docker compose up -d
npm run build && npm test
npm run test:postgres:v3
npm run test:types && npm run test:types:postgres:v3
```

Override test connection strings with `PG_URL` and `MYSQL_URL`. To add another driver, see the [custom driver guide](self-implement-guide.md).

The v3 suite uses an isolated workspace with postgres.js 3.4.x; the installed 4.x dependency is unchanged. Tests for native dirty-reservation release and disconnect behavior, batch queries and instance `query_timeout` run only on 4.x.

After building, run the real-database CommonJS smoke test with both postgres.js majors on Node.js 18, 20.10 and 22 (with `--no-experimental-require-module` on 22):

```bash
bash scripts/test/postgres-node-compat.sh --all
```

With no arguments it uses the current `node`. Pass a runner to select one version, for example `bash scripts/test/postgres-node-compat.sh npx -y node@20.10.0`.
