# TranJS

[![Test](https://github.com/asheswook/tranjs/actions/workflows/test.yml/badge.svg)](https://github.com/asheswook/tranjs/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/@tranjs/core)](https://www.npmjs.com/package/@tranjs/core)
[![license](https://img.shields.io/npm/l/@tranjs/core)](https://github.com/asheswook/tranjs/blob/main/LICENSE)

Declarative transactions for JavaScript and TypeScript, without an ORM. Queries are written with the driver's own API (`pg`, `postgres`, or `mysql2`); TranJS manages the transaction around them, with semantics modeled on Spring's `@Transactional`.

```typescript
// Example: a service with @Transactional methods (pg).
// Assumes a registered pg manager and an accounts(id, balance) table.
import { Transactional, Propagation } from "@tranjs/core";
import { ctx } from "@tranjs/pg";

class AccountService {
    @Transactional()
    async transfer(from: string, to: string, amount: number) {
        await this.withdraw(from, amount);
        await this.deposit(to, amount);
    }   // commits here, or rolls back both updates if anything threw

    @Transactional(Propagation.MANDATORY)
    private async withdraw(id: string, amount: number) {
        await ctx().query("UPDATE accounts SET balance = balance - $1 WHERE id = $2", [amount, id]);
    }

    @Transactional(Propagation.MANDATORY)
    private async deposit(id: string, amount: number) {
        await ctx().query("UPDATE accounts SET balance = balance + $1 WHERE id = $2", [amount, id]);
    }
}
```

`ctx()` returns the connection of the current transaction, so nested calls share it without passing it around.

## Features

- Declarative transactions with `@Transactional`, or `transactional` for plain functions
- All 7 Spring propagation types: `REQUIRED`, `REQUIRES_NEW`, `MANDATORY`, `SUPPORTS`, `NOT_SUPPORTED`, `NEVER`, `NESTED` (savepoints)
- Spring rollback rules: a failure in a joined method marks the whole transaction rollback-only
- Isolation level, read-only and timeout per transaction
- Multiple datasources, each with independent transactions
- `afterCommit` / `afterRollback` hooks
- PostgreSQL and MySQL through `pg`, `postgres` (postgres.js) and `mysql2`, or a [custom driver](https://github.com/asheswook/tranjs/blob/main/docs/self-implement-guide.md)
- Node.js, Bun, Deno and Cloudflare Workers
- Written in TypeScript, with no runtime dependencies in the core package

## Install

```bash
# PostgreSQL (pg)
npm install @tranjs/core @tranjs/pg pg

# PostgreSQL (postgres.js)
npm install @tranjs/core @tranjs/postgres postgres

# MySQL
npm install @tranjs/core @tranjs/mysql2 mysql2
```

`@tranjs/core` needs Node.js 16.4 or later. `@tranjs/postgres` needs Node.js 18 or later.

`@Transactional` is a TypeScript legacy decorator and needs `experimentalDecorators`. With standard decorators the class definition throws a `TypeError`. `transactional()` needs no compiler option.

```jsonc
// tsconfig.json. Only for @Transactional; transactional() needs no compiler option.
{ "compilerOptions": { "experimentalDecorators": true } }
```

A transaction manager is registered per datasource. Each driver has a helper for it:

```typescript
// Example: pg
import { Pool } from "pg";
import { usePostgreSQLTransactionManager } from "@tranjs/pg";

usePostgreSQLTransactionManager(new Pool({ connectionString: process.env.DATABASE_URL }));
```

```typescript
// Example: postgres.js
import postgres from "postgres";
import { usePostgresTransactionManager } from "@tranjs/postgres";

usePostgresTransactionManager(postgres(process.env.DATABASE_URL!));
```

```typescript
// Example: mysql2
import { createPool } from "mysql2/promise";
import { useMySQLTransactionManager } from "@tranjs/mysql2";

useMySQLTransactionManager(createPool(process.env.DATABASE_URL!));
```

Registration replaces the manager for that datasource process-wide. A transaction that began under the previous manager keeps running, but a transactional call made inside it afterwards resolves the new manager and begins a separate transaction instead of joining. That is why registration belongs at startup or module scope and not in a request handler.

## Without decorators

```typescript
// Example: transactional() around a plain function (pg).
// Assumes a registered pg manager and an orders(user_id) table.
import { transactional, IsolationLevel } from "@tranjs/core";
import { ctx } from "@tranjs/pg";

const createOrder = transactional(async (userId: string) => {
    const { rows } = await ctx().query("INSERT INTO orders (user_id) VALUES ($1) RETURNING *", [userId]);
    return rows[0];
}, { isolationLevel: IsolationLevel.SERIALIZABLE, timeout: 5000 });

const order = await createOrder("user-1");
```

`transactional(fn, config?)` wraps a function and keeps its arguments and the `this` it is called with. The function can be synchronous or asynchronous; the wrapper always returns a Promise. See [transaction scopes](https://github.com/asheswook/tranjs/blob/main/docs/api.md#transaction-scopes).

## Rollback rules

- If a method throws, its transaction rolls back and the error is rethrown.
- If an inner method that joined the transaction throws, the whole transaction is marked rollback-only. Catching the error in the outer method does not save it; the commit turns into a rollback and throws `UnexpectedRollbackError`.
- An inner step fails on its own under `Propagation.REQUIRES_NEW` (a separate transaction on a second connection, which stays committed if the outer one later rolls back) or `Propagation.NESTED` (a savepoint, which rolls back with the outer one).

```typescript
// Partial example: a method of a service class.
// this.audit.record is @Transactional(Propagation.REQUIRES_NEW).
@Transactional()
async placeOrder(order: Order) {
    await this.saveOrder(order);
    try {
        await this.audit.record(order);
    } catch {
        // audit failure is rolled back on its own; the order still commits
    }
}
```

## Testing

`@tranjs/testing` runs a service against a real database and rolls its writes back, or checks transaction boundaries with no database. Example with Jest and `pg`; `example_users` stands for any table:

```typescript
// Example (Jest + pg). Assumes a registered pg manager and any table
// with a text column, here example_users(name).
import { expect, test } from "@jest/globals";
import { transactional } from "@tranjs/core";
import { ctx } from "@tranjs/pg";
import { withTestTransaction } from "@tranjs/testing";
import "@tranjs/testing/jest";

const repository = {
    async save(name: string) {
        await ctx().query("INSERT INTO example_users(name) VALUES ($1)", [name]);
    },
};
function createUserService(repo: typeof repository) {
    return { create: transactional(async (name: string) => repo.save(name)) };
}

test("create saves a user in a transaction", () => withTestTransaction(async tx => {
    const trackedRepository = tx.track(repository);
    const service = createUserService(trackedRepository);
    await service.create("Ada");
    expect(trackedRepository.save).toHaveCommitted();
}));
```

See [connection lifetime](https://github.com/asheswook/tranjs/blob/main/docs/drivers.md#connection-lifetime) for connection rules and the [testing guide](https://github.com/asheswook/tranjs/blob/main/docs/testing.md) for the example setup and more examples.

## Supported platforms

| Platform | Status | Mode |
|---|---|---|
| Node.js | Supported | Pool mode |
| Bun | Supported | Pool mode |
| Deno | Supported | Pool mode, with `npm:` specifiers. `@Transactional` needs `"experimentalDecorators": true` in `deno.json`. |
| AWS Lambda, Vercel Functions (Node.js runtime) | Supported | Pool mode, registered once at module scope |
| Cloudflare Workers | Supported | Connection-per-transaction mode with [Hyperdrive](https://developers.cloudflare.com/hyperdrive/) |
| Edge runtimes without TCP sockets (e.g. Vercel Edge) | Not supported | The drivers need TCP connections |

CI runs the test suites on Node.js only.

### Cloudflare Workers

Workers cannot keep a connection pool across requests, so the pool managers do not apply. The connection-per-transaction managers open one connection per transaction and need the `nodejs_compat` flag. Example with Hyperdrive:

```typescript
// Example: Cloudflare Workers + Hyperdrive (pg).
// Assumes a Hyperdrive binding named HYPERDRIVE.
import { env } from "cloudflare:workers";
import { usePostgreSQLClientPerTransaction } from "@tranjs/pg";

usePostgreSQLClientPerTransaction(() => ({ connectionString: env.HYPERDRIVE.connectionString }));
```

postgres.js has `usePostgresConnectionPerTransaction` and MySQL has `useMySQLConnectionPerTransaction`. Hyperdrive ignores MySQL isolation levels, so the MySQL mode rejects them. See [Cloudflare Workers + Hyperdrive](https://github.com/asheswook/tranjs/blob/main/docs/drivers.md#cloudflare-workers--hyperdrive).

## Documentation

- [API](https://github.com/asheswook/tranjs/blob/main/docs/api.md): propagation, options, hooks, multiple datasources, errors
- [Drivers](https://github.com/asheswook/tranjs/blob/main/docs/drivers.md): PostgreSQL, MySQL, Cloudflare Workers
- [Testing](https://github.com/asheswook/tranjs/blob/main/docs/testing.md): mockTransactions, withTestTransaction, Jest, Vitest
- [Custom drivers](https://github.com/asheswook/tranjs/blob/main/docs/self-implement-guide.md)
- [Examples](https://github.com/asheswook/tranjs/tree/main/examples)

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](https://github.com/asheswook/tranjs/blob/main/CONTRIBUTING.md) lists the local test commands.

## License

[LGPL-2.1-only](https://github.com/asheswook/tranjs/blob/main/LICENSE)

Inspired by the [Spring Framework](https://github.com/spring-projects/spring-framework).
