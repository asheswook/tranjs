# @tranjs/mysql2

[TranJS](https://github.com/asheswook/tranjs#readme) driver for [`mysql2`](https://sidorares.github.io/node-mysql2/docs) (MySQL). It registers a transaction manager for a `mysql2/promise` pool and exports `ctx()`, which returns the connection of the current transaction.

## Install

```bash
# @tranjs/mysql2 with mysql2
npm install @tranjs/core @tranjs/mysql2 mysql2
```

## Example

```typescript
// Example: pool mode (mysql2). The env var name is illustrative.
import { createPool } from "mysql2/promise";
import { transactional } from "@tranjs/core";
import { ctx, useMySQLTransactionManager } from "@tranjs/mysql2";

useMySQLTransactionManager(createPool(process.env.DATABASE_URL!));

const readOne = transactional(async () => {
    const [rows] = await ctx().query("SELECT 1 AS one");
    return rows;
});
```

`useMySQLConnectionPerTransaction(config)` registers the connection-per-transaction manager, which opens one connection per transaction. It is the mode for Cloudflare Workers with Hyperdrive.

## Documentation

- [MySQL (mysql2)](https://github.com/asheswook/tranjs/blob/main/docs/drivers.md#mysql-mysql2): connection types, isolation
- [Connection lifetime](https://github.com/asheswook/tranjs/blob/main/docs/drivers.md#connection-lifetime)
- [Cloudflare Workers + Hyperdrive](https://github.com/asheswook/tranjs/blob/main/docs/drivers.md#hyperdrive-with-mysql2)
- [API](https://github.com/asheswook/tranjs/blob/main/docs/api.md): `@Transactional`, `transactional`, propagation, hooks, errors
