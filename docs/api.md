# TranJS API Documentation

## Transaction

- `@Transactional`
    - Declares that a method should be executed within a transaction.
    - Accepts an optional propagation option (default is `REQUIRED`).

- ~~`@Query`~~ **(Experimental)**
    - ~~Associates an SQL query with a method.~~
    - ~~Enables parameter binding through the use of `@Param`.~~

- ~~`@Param`~~ **(Experimental)**
    - ~~Binds method parameters to SQL query parameters.~~

### Usage

```typescript
import { Transactional, ctx } from '@tranjs/core';

class MyService {
    @Transactional()
    async createUser(id: string, name: string) {
        const res = await ctx().execute(
            "INSERT INTO user (id, name) VALUES (?, ?)",
            [id, name],
        );
        
        return res;
    }
}
```

### ~~With `@Query` and `@Param`~~ (Experimental)

```typescript
import { Transactional, Query, Param } from '@tranjs/mysql2';

class MyService {
    @Transactional()
    @Query("INSERT INTO user (id, name) VALUES (:id, :name)")
    async createUser(
        @Param('id') id: string,
        @Param('name') name: string,
    ) {}
}
```

**This feature is under development and not yet available.**

## Propagations

| Propagation Type | Supported | Description                                                                             |
|------------------|:---------:|-----------------------------------------------------------------------------------------|
| REQUIRED         |     O     | Uses the current transaction if one exists; otherwise, begins a new transaction.        |
| REQUIRES_NEW     |     O     | Always starts a new transaction, suspending any current transaction.                    |
| MANDATORY        |     O     | Requires an existing transaction, otherwise throws an exception.                        |
| SUPPORTS         |     X     | Executes within the current transaction if available.                                   |
| NOT_SUPPORTED    |     X     | Runs without a transactional context even if context is available.                      |
| NEVER            |     X     | Must not be executed within a transactional context; throws an exception if one exists. |

You can import `Propagation` from `@tranjs/core` to use it.

```typescript
import { Propagation } from "@tranjs/core";
```

## Exceptions

- **DatasourceSetupError**
    - Thrown when a datasource is not set up. You must set up by calling `useTransactionManager()`

- **IllegalTransactionStateException**
    - Thrown when the current transactional state violates the expected propagation rules.
    - Can be thrown when a propagation is `MANDATORY`, `NEVER`.

- **UnsupportedTransactionPropagationException**
  - Thrown when an unsupported propagation type is used.
