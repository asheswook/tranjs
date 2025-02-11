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
        await ctx().execute("SELECT 1;")
    }
}
```

That’s it! You’re ready to use TranJS with PostgreSQL.

## Custom Driver

If your desired database driver isn’t available, you can always implement your own by installing just the core package. 
For guidance on self-implementation, refer to the [Self-Implementation Guide](/docs/self-implement-guide.md).