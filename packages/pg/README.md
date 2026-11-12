# @tranjs/pg

[TranJS](https://github.com/asheswook/tranjs#readme) driver for [`pg`](https://node-postgres.com/) (PostgreSQL). It registers a transaction manager for a `pg.Pool` and exports `ctx()`, which returns the connection of the current transaction.

## Install

```bash
# @tranjs/pg with pg
npm install @tranjs/core @tranjs/pg pg
```

## Example

```typescript
// Example: pool mode (pg). The env var name is illustrative.
import { Pool } from "pg";
import { transactional } from "@tranjs/core";
import { ctx, usePostgreSQLTransactionManager } from "@tranjs/pg";

usePostgreSQLTransactionManager(new Pool({ connectionString: process.env.DATABASE_URL }));

const readOne = transactional(async () => {
    const { rows } = await ctx().query("SELECT 1 AS one");
    return rows[0].one;
});
```

`usePostgreSQLClientPerTransaction(config)` registers the connection-per-transaction manager, which opens one `pg.Client` per transaction. It is the mode for Cloudflare Workers with Hyperdrive.

## Documentation

- [PostgreSQL (pg)](https://github.com/asheswook/tranjs/blob/main/docs/drivers.md#postgresql-pg): connection types, isolation, statement errors
- [Connection lifetime](https://github.com/asheswook/tranjs/blob/main/docs/drivers.md#connection-lifetime)
- [Cloudflare Workers + Hyperdrive](https://github.com/asheswook/tranjs/blob/main/docs/drivers.md#hyperdrive-with-pg)
- [API](https://github.com/asheswook/tranjs/blob/main/docs/api.md): `@Transactional`, `transactional`, propagation, hooks, errors
