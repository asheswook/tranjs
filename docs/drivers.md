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

| Runtime | Support and verification |
|---|---|
| Node.js | Supported, primary target. |
| Bun 1.3 | Verified locally with the packed packages (pg pool and per-transaction mode, mysql2 pool; 50 concurrent transactions, isolation, NESTED, rollback-only, timeout). |
| Deno 2.9 | Verified locally via `npm:` specifiers with the published 1.1.0 packages (same checks; needs `experimentalDecorators` in deno.json, which Deno marks deprecated). |
| AWS Lambda / Vercel Functions (Node runtime) / other long-lived Node hosts | Use the pool mode and register once at module scope. Not tested on those platforms; this follows from them running Node.js. |
| Cloudflare Workers | Supported through the connection-per-transaction mode + Hyperdrive, verified on real Workers. |
| Edge runtimes without TCP sockets (e.g. Vercel Edge) | Not supported; the drivers need TCP. |

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

The following Hyperdrive MySQL limitations were verified on Workers with identical SQL, independently of the packaged manager:

| Limitation | Consequence |
|---|---|
| Isolation settings are silently ignored | Neither `SET TRANSACTION` nor `SET SESSION` changes isolation. Setting it after `START` fails. `SELECT @@transaction_isolation` returns an empty result set, so it cannot detect this limitation. |
| `START TRANSACTION READ ONLY` blocks writes but drops the connection on a violation | The error is `PROTOCOL_CONNECTION_LOST`, not `ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION`; subsequent rollback also fails. |
| Protocol prepared statements are unsupported | Use `ctx().query()`, not `ctx().execute()`. The latter fails with `ER_NO Hyperdrive does not currently support MySQL COM_STMT_PREPARE messages`. |
| No multi-statement queries | Issue statements separately. |
| No `USE` | Set the database in the connection config. |

`MySQLConnectionPerTransactionManager` therefore rejects explicit isolation levels with `UnsupportedIsolationLevelError` **before connecting** by default. Without an explicit level, the server default applies; do not assume stronger guarantees. Hyperdrive cannot be detected reliably at runtime.

The packaged manager, registered with `useMySQLConnectionPerTransaction` and used through `@Transactional`, was also verified on Cloudflare Workers + Hyperdrive (MySQL 8):

| Check | Result |
|---|---|
| 1, 50, and 100 concurrent requests | All succeeded; connection id stayed constant within each transaction. |
| Commit, rollback, `NESTED`, `REQUIRES_NEW`, deadline timeouts, `afterCommit` errors, rollback-only | Same behaviour as Node: `TransactionTimeoutError`, propagated hook errors, and `UnexpectedRollbackError` where applicable. |
| Explicit isolation level | Rejected by default as described above. |
| `readOnly` write | Blocked; nothing persisted. Failed rollback surfaced as `TransactionSystemError` (`"Transaction rollback failed after application error"`), with `PROTOCOL_CONNECTION_LOST` in `applicationError`. |

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
