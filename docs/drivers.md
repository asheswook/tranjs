# Native Drivers for TranJS

## Supported Drivers

### [MySQL Drivers](#MySQL-Driver)
- [mysql2](https://npmjs.com/package/mysql2)
    - Use the `@tranjs/mysql2` package to integrate with MySQL databases.

### [PostgreSQL Drivers](#PostgreSQL-Driver)
- [pg](https://npmjs.com/package/pg)
    - Use the `@tranjs/pg` package to integrate with PostgreSQL databases.

## MySQL Driver

### Installation

```bash
npm install @tranjs/core @tranjs/mysql2 --save
```

### Usage

```typescript
import { createPool } from "mysql2/promise";
import { useMySQLTransactionManager } from "@tranjs/mysql2";

const pool = createPool({
  host: 'localhost',
  user: 'admin',
})

// Don't need to `useTransactionManager`,
// if you use `useMySQLTransactionManager`
useMySQLTransactionManager(pool);
```

```typescript
import { Transactional } from "@tranjs/core";
import { ctx } from "@tranjs/mysql2";

class MyService {
    @Transactional()
    async method() {
        await ctx().execute("SELECT 1;")
    }
}
```

That’s it! You’re ready to use TranJS with MySQL.

## PostgreSQL Driver

### Installation

```bash
npm install @tranjs/core @tranjs/pg --save
```

### Usage

```typescript
import { Pool } from "pg";
import { usePostgreSQLTransactionManager } from "@tranjs/pg";

const pool = new Pool({
  host: 'localhost',
  user: 'database-user',
})

// Don't need to `useTransactionManager`,
// if you use `usePostgreSQLTransactionManager`
usePostgreSQLTransactionManager(pool);
```

```typescript
import { Transactional } from "@tranjs/core";
import { ctx } from "@tranjs/pg";

class MyService {
    @Transactional()
    async method() {
        await ctx().query("SELECT 1;")
    }
}
```

That’s it! You’re ready to use TranJS with PostgreSQL.

## Cloudflare Workers + Hyperdrive

Enable [`nodejs_compat`](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) in your Worker configuration. Register transaction managers **once at module scope**, not inside the request handler.

### PostgreSQL

Use `pg >= 8.16.3`:

```ts
import { env } from "cloudflare:workers";
import { usePostgreSQLClientPerTransaction } from "@tranjs/pg";

usePostgreSQLClientPerTransaction(() => ({ connectionString: env.HYPERDRIVE.connectionString }));
```

Use `runInTransaction` / `@Transactional` and `ctx()` as usual. This mode uses no `pg.Pool`: it resolves the config (or async config factory) and opens a new `pg.Client` for each physical transaction, then calls `end()` automatically on completion, including failures. No `end()` is needed in user code. Joined and `NESTED` scopes reuse the current client; `REQUIRES_NEW` opens another one. For direct registration, use `new PostgreSQLClientPerTransactionManager(config)` with `useTransactionManager`; both registration helpers accept an optional datasource name.

[Hyperdrive uses transaction-mode pooling](https://developers.cloudflare.com/hyperdrive/configuration/connection-pooling/), so session state cannot be relied on between transactions:

- `SET` outside a transaction does not persist; use transaction-local settings inside the transaction.
- No session advisory locks (use transaction-scoped advisory locks instead).
- No `LISTEN` / `NOTIFY`.
- No SQL `PREPARE`.

On Node without Hyperdrive, this mode opens a new database connection per physical transaction; prefer the existing `Pool` manager there to reuse connections.

### MySQL

Use `mysql2 >= 3.13.0` with `disableEval: true`. Register once at module scope:

```ts
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

This mode uses no application-side pool: each physical transaction gets a fresh connection and TranJS calls `end()` automatically, including after failures. No `end()` is needed in user code. Config may be an object, a sync factory, or an async factory. Use `runInTransaction` / `@Transactional` with `ctx()` from `@tranjs/mysql2`; joined and `NESTED` scopes reuse the connection, while `REQUIRES_NEW` opens another one.

Hyperdrive MySQL caveats:

- **Verified on Workers:** Isolation levels are silently ignored through Hyperdrive; `SET TRANSACTION` and `SET SESSION` do not change the transaction's isolation. Setting isolation after `START` fails, and `SELECT @@transaction_isolation` returns an empty result set, so it cannot detect this limitation. This mode therefore rejects requested isolation levels with `UnsupportedIsolationLevelError` **before connecting** by default. Transactions without an explicit isolation level use the server's default; do not assume stronger guarantees.
- **Verified on Workers:** `START TRANSACTION READ ONLY` blocks writes, but a violation drops the connection (`PROTOCOL_CONNECTION_LOST`) rather than returning `ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION`. The subsequent rollback also fails, so TranJS throws `TransactionSystemError` ("Transaction rollback failed after application error"), with the connection-lost error in `applicationError`.
- **Verified on Workers:** Use `ctx().query()`, not `ctx().execute()`: protocol prepared statements fail with `ER_NO Hyperdrive does not currently support MySQL COM_STMT_PREPARE messages`.
- **Verified on Workers:** No multi-statement queries; issue each statement separately.
- **Verified on Workers:** No `USE`; select the database in the connection config.

Commit, rollback, savepoints, `REQUIRES_NEW`, stable connection IDs within transactions, and 100 concurrent requests have been verified on Workers. Reads inside a transaction did not return stale cached results even with Hyperdrive caching enabled.

For **direct MySQL connections only**, explicitly opt into applying isolation settings:

```ts
useMySQLConnectionPerTransaction(config, undefined, { isolationLevel: "apply" });
// Or: useTransactionManager(new MySQLConnectionPerTransactionManager(config, { isolationLevel: "apply" }));
```

The constructor accepts `(config, options?)`; the registration helper accepts `(config, name?, options?)`. `isolationLevel: "reject"` is the default; `"apply"` uses `SET TRANSACTION ISOLATION LEVEL` followed by `START TRANSACTION`. Hyperdrive cannot be detected reliably at runtime: do not enable `"apply"` there. The existing pool manager is unchanged. On Node without Hyperdrive, prefer `useMySQLTransactionManager(pool)` to avoid opening a new connection per physical transaction.

## Driver Features

| | mysql2 | pg |
|---|:-:|:-:|
| Isolation level | `SET TRANSACTION ISOLATION LEVEL` (connection-per-transaction mode rejects by default; opt into `"apply"` for direct MySQL only) | `BEGIN ISOLATION LEVEL` |
| Read-only | `START TRANSACTION READ ONLY` | `BEGIN READ ONLY` |
| Client-side query timeout | Remaining deadline as query/execute `timeout` | Remaining deadline as `query_timeout` (except Submittables) |
| NESTED (savepoint) | O | O |
| Multiple datasources | `useMySQLTransactionManager(pool, name)` / `ctx(name)` | `usePostgreSQLTransactionManager(pool, name)` / `ctx(name)` |

### Deadlines and query options

`timeout` must be finite, nonnegative, and at most `2147483647` ms. Use the native `ctx()` wrappers to check the transaction deadline before query dispatch. For ordinary queries, the remaining transaction timeout always overrides user PostgreSQL `query_timeout` / MySQL query/execute `timeout` and pool defaults, even shorter ones. Without a transaction deadline, user options are untouched. PostgreSQL does not set `SET LOCAL statement_timeout`; these client-side timeouts do not guarantee server-side cancellation. The owner also checks the deadline before commit.

PostgreSQL Submittables (`pg.Query`, `pg-query-stream`, `pg-cursor`) are checked only before dispatch and passed through untouched, with no per-query timeout injection or interception. Consume streams inside the transactional callback so work finishes before commit; the owner's final deadline check still applies.

## Development

Driver tests run against real databases:

```bash
docker compose up -d
npm run build && npm test
```

Override the connection strings with `PG_URL` and `MYSQL_URL`.

## Custom Driver

If your desired database driver isn’t available, you can always implement your own by installing just the core package. 
For guidance on self-implementation, refer to the [Self-Implementation Guide](/docs/self-implement-guide.md).
