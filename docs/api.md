# TranJS API Documentation

## Decorator

- `@Transactional`
    - Declares that a method should be executed within a transaction.
    - Accepts an optional propagation option (default is `REQUIRED`).

## Usage

### 1. Initialize the transaction manager

```typescript
import { useTransactionManager } from "@tranjs/core";

useTransactionManager(new YOUR_TX_MANAGER());
```

Put `YOUR_TX_MANAGER` that you want to use. If you want to use Native supported drivers, see [Native Drivers for TranJS](/docs/drivers.md).

Or you can implement your own driver. See [Self-Implementation Database Driver](/docs/self-implement-guide.md).

### 2. Use `@Transactional` decorator

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

## Using Multiple Datasources

Using multiple datasources is not supported yet, but planned for a future release. See this [issue](https://github.com/asheswook/tranjs/issues/1#issue-2840465733).

## Exceptions

- **DatasourceSetupError**
    - Thrown when a datasource is not set up. You must set up by calling `useTransactionManager()`

- **IllegalTransactionStateException**
    - Thrown when the current transactional state violates the expected propagation rules.
    - Can be thrown when a propagation is `MANDATORY`, `NEVER`.

- **UnsupportedTransactionPropagationException**
  - Thrown when an unsupported propagation type is used.

- **TransactionContextMixingError**
  - Thrown mixed `ctx()` use when current transaction context is different from the one that started the transaction.