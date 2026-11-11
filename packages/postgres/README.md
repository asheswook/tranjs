# @tranjs/postgres

[TranJS](https://github.com/asheswook/tranjs#readme) driver for [postgres.js](https://github.com/porsager/postgres) (PostgreSQL). It registers a transaction manager for a `postgres()` instance and exports `ctx()`, which returns the connection reserved for the current transaction.

## Install

```bash
# @tranjs/postgres with postgres.js
npm install @tranjs/core @tranjs/postgres postgres
```

Works with postgres.js `^3.4.0 || ^4.1.0` on Node.js 18 or later.

## Example

```typescript
// Example: pool mode (postgres.js). The env var name is illustrative.
import postgres from "postgres";
import { transactional } from "@tranjs/core";
import { ctx, usePostgresTransactionManager } from "@tranjs/postgres";

usePostgresTransactionManager(postgres(process.env.DATABASE_URL!));

const readOne = transactional(async () => {
    const [row] = await ctx()`SELECT 1 AS one`;
    return row.one;
});
```

`usePostgresConnectionPerTransaction(config)` registers the connection-per-transaction manager, which opens one connection per transaction. It is the mode for Cloudflare Workers with Hyperdrive.

## Documentation

- [PostgreSQL (postgres.js)](https://github.com/asheswook/tranjs/blob/main/docs/drivers.md#postgresql-postgresjs): connection type, timeouts, differences between postgres.js 3.x and 4.x
- [Connection lifetime](https://github.com/asheswook/tranjs/blob/main/docs/drivers.md#connection-lifetime)
- [Cloudflare Workers + Hyperdrive](https://github.com/asheswook/tranjs/blob/main/docs/drivers.md#hyperdrive-with-postgresjs)
- [API](https://github.com/asheswook/tranjs/blob/main/docs/api.md): `@Transactional`, `transactional`, propagation, hooks, errors
