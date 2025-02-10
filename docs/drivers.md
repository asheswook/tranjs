# Native Drivers for TranJS

## Supported Drivers

### MySQL
- [mysql2](https://npmjs.com/package/mysql2)
    - Use the `@tranjs/mysql2` package to integrate with MySQL databases.

### ~~PostgreSQL~~ (Under Development)
- [pg](https://npmjs.com/package/pg)
    - ~~Use the `@tranjs/pg` package to integrate with PostgreSQL databases.~~

## MySQL Driver

### Installation

```bash
npm install @tranjs/core @tranjs/mysql2 --save
```

### Usage

```typescript
import { createPool } from "mysql2/promise";
import { MySQLTransactionManager } from "@tranjs/mysql2";
import { useTransactionManager } from "@tranjs/core";

const pool = createPool({
  host: 'localhost',
  port: 3306,
  user: 'admin',
  password: 'password',
  database: 'mydb',
})

useTransactionManager(new MySQLTransactionManager(pool));
```

That’s it! You’re ready to use TranJS with MySQL.

## PostgreSQL Driver

Currently under development.

## Custom Drivers

If your desired database driver isn’t available, you can always implement your own by installing just the core package. 
For guidance on self-implementation, refer to the [Self-Implementation Guide](/docs/self-implement-guide.md).