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

Isolation uses `BEGIN ISOLATION LEVEL …`; read-only uses `BEGIN … READ ONLY`. Savepoints and named datasources are supported. See [transaction options and deadlines](api.md#isolation-readonly-and-timeout), including the special handling of PostgreSQL Submittables.

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

Connection-per-transaction managers use no application-side pool. Each physical transaction resolves a config object, synchronous factory, or async factory, opens a connection, and calls `end()` automatically on completion, including failures. Use `runInTransaction` / `@Transactional` and the driver's `ctx()` as usual. Joined and `NESTED` scopes reuse the connection; `REQUIRES_NEW` opens another. On Node without Hyperdrive, prefer the pool managers to reuse connections.

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
```

Override test connection strings with `PG_URL` and `MYSQL_URL`. To add another driver, see the [custom driver guide](self-implement-guide.md).
