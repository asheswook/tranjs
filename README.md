# TranJS

[![Test](https://github.com/asheswook/tranjs/actions/workflows/test.yml/badge.svg)](https://github.com/asheswook/tranjs/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/@tranjs/core)](https://www.npmjs.com/package/@tranjs/core)
[![license](https://img.shields.io/npm/l/@tranjs/core)](https://github.com/asheswook/tranjs/blob/main/LICENSE)

![Node.js](https://img.shields.io/badge/Node.js-supported-339933?logo=nodedotjs&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-supported-000000?logo=bun&logoColor=white)
![Deno](https://img.shields.io/badge/Deno-supported-000000?logo=deno&logoColor=white)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare%20Workers-supported-F38020?logo=cloudflareworkers&logoColor=white)

Declarative transactions for JavaScript and TypeScript, without an ORM. You write SQL with your usual driver (`pg`, `postgres`, or `mysql2`); TranJS manages the transaction around it, with semantics modelled on Spring's `@Transactional`.

```ts
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

- ✅ **Declarative transactions** with `@Transactional`, or `runInTransaction` for plain functions
- 🔁 **All 7 Spring propagation types**: `REQUIRED`, `REQUIRES_NEW`, `MANDATORY`, `SUPPORTS`, `NOT_SUPPORTED`, `NEVER`, `NESTED` (savepoints)
- 🛡️ **Spring rollback rules**: a failure in a joined method marks the whole transaction rollback-only
- 🎛️ **Isolation level, read-only and timeout** per transaction
- 🗄️ **Multiple datasources**, each with independent transactions
- 🪝 **`afterCommit` / `afterRollback` hooks**
- 🐘 **PostgreSQL and MySQL** through `pg`, `postgres` (postgres.js), and `mysql2`, or [your own driver](https://github.com/asheswook/tranjs/blob/main/docs/self-implement-guide.md)
- ☁️ **Runs on Node.js, Bun, Deno and Cloudflare Workers**
- ⚡ **TypeScript native**, no runtime dependencies in the core package

## Install

```bash
# PostgreSQL (pg)
npm install @tranjs/core @tranjs/pg pg

# PostgreSQL (postgres.js)
npm install @tranjs/core @tranjs/postgres postgres

# MySQL
npm install @tranjs/core @tranjs/mysql2 mysql2
```

Enable decorators in `tsconfig.json`:

```json
{ "compilerOptions": { "experimentalDecorators": true } }
```

Register a transaction manager once at startup:

```ts
import { Pool } from "pg";
import { usePostgreSQLTransactionManager } from "@tranjs/pg";

usePostgreSQLTransactionManager(new Pool({ connectionString: process.env.DATABASE_URL }));
```

```ts
import { createPool } from "mysql2/promise";
import { useMySQLTransactionManager } from "@tranjs/mysql2";

useMySQLTransactionManager(createPool(process.env.DATABASE_URL!));
```

Register managers once, not inside a request handler. Re-registering per request breaks concurrent requests.

## Without decorators

```ts
import { runInTransaction, IsolationLevel } from "@tranjs/core";
import { ctx } from "@tranjs/pg";

const order = await runInTransaction(async () => {
    const { rows } = await ctx().query("INSERT INTO orders (user_id) VALUES ($1) RETURNING *", [userId]);
    return rows[0];
}, { isolationLevel: IsolationLevel.SERIALIZABLE, timeout: 5000 });
```

## Rollback rules

- If a method throws, its transaction rolls back and the error is rethrown.
- If an inner method that joined the transaction throws, the whole transaction is marked rollback-only. Catching the error in the outer method does not save it; the commit turns into a rollback and throws `UnexpectedRollbackError`. To let an inner step fail on its own, use `Propagation.REQUIRES_NEW` (separate transaction) or `Propagation.NESTED` (savepoint).

```ts
@Transactional()
async placeOrder(order: Order) {
    await this.saveOrder(order);
    try {
        await this.audit.record(order);   // @Transactional(Propagation.REQUIRES_NEW)
    } catch {
        // audit failure is rolled back on its own; the order still commits
    }
}
```

## Testing

`@tranjs/core/testing` rolls back awaited transactional work run through the registered manager (via services, `runInTransaction`, or `@Transactional`). It does **not** cover raw pool/connection queries, other datasources, work not awaited inside the callback, external effects, or fixtures created outside the callback. Transactions opened by code under test use savepoints; "committed" means the logical owner's savepoint was released, not a durable physical commit.

**The hidden test transaction is not ambient.** Wrap direct SQL, including fixture and assertion queries, in `runInTransaction` or `@Transactional`; `ctx()` alone is unavailable. Making it ambient would let `REQUIRED` services join it instead of owning a savepoint, preventing checks of service atomicity.

```ts
import { withTestTransaction } from "@tranjs/core/testing";
import { runInTransaction } from "@tranjs/core";

test("place() leaves no order when stock is short", () => withTestTransaction(async () => {
  await runInTransaction(() => seedStock("A", 0));
  await expect(orderService.place({ sku: "A" })).rejects.toThrow(OutOfStock);
  expect(await runInTransaction(countOrders)).toBe(0);
}));
```

Standard `expect` matchers check tracked call entry and logical outcomes, such as "these calls entered the same transaction" or "this mailer call ran through an afterCommit callback". They do not prove async completion or external delivery. Works with Jest 29/30, Vitest 3/4/5, node:test and Mocha.

Details, limitations and examples: [Testing guide](https://github.com/asheswook/tranjs/blob/main/docs/testing.md).

## Supported platforms

| Platform | Status | How to use |
|---|---|---|
| Node.js | ✅ Supported | Pool mode (`usePostgreSQLTransactionManager`, `useMySQLTransactionManager`) |
| Bun | ✅ Supported | Same as Node.js |
| Deno | ✅ Supported | Same as Node.js, with `npm:` specifiers and `experimentalDecorators` in `deno.json` |
| AWS Lambda, Vercel Functions (Node.js runtime) | ✅ Supported | Pool mode, registered once at module scope |
| Cloudflare Workers | ✅ Supported | Connection-per-transaction mode with [Hyperdrive](https://developers.cloudflare.com/hyperdrive/) |
| Edge runtimes without TCP sockets (e.g. Vercel Edge) | ❌ Not supported | The drivers need TCP connections |

### Cloudflare Workers

Workers can't share a connection pool between requests. Use the connection-per-transaction mode and register it at module scope:

```ts
import { env } from "cloudflare:workers";
import { usePostgreSQLClientPerTransaction } from "@tranjs/pg";

usePostgreSQLClientPerTransaction(() => ({ connectionString: env.HYPERDRIVE.connectionString }));
```

MySQL works the same way with `useMySQLConnectionPerTransaction`, but Hyperdrive ignores MySQL isolation levels, so this mode rejects them. See [Cloudflare Workers + Hyperdrive](https://github.com/asheswook/tranjs/blob/main/docs/drivers.md#cloudflare-workers--hyperdrive).

## Documentation

- [API](https://github.com/asheswook/tranjs/blob/main/docs/api.md): propagation, options, hooks, multiple datasources, errors
- [Drivers](https://github.com/asheswook/tranjs/blob/main/docs/drivers.md): PostgreSQL, MySQL, Cloudflare Workers
- [Testing](https://github.com/asheswook/tranjs/blob/main/docs/testing.md): mockTransactions, withTestTransaction, Jest, Vitest
- [Writing your own driver](https://github.com/asheswook/tranjs/blob/main/docs/self-implement-guide.md)
- [Examples](https://github.com/asheswook/tranjs/tree/main/examples)

## Contributing

Issues and pull requests are welcome. To run the tests locally:

```bash
docker compose up -d
npm install
npm run build && npm test
```

## License

[LGPL-2.1](https://github.com/asheswook/tranjs/blob/main/LICENSE)

Inspired by the [Spring Framework](https://github.com/spring-projects/spring-framework).
