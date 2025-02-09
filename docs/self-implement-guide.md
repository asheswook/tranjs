# Self-Implementation Guide

If the desired database driver isn’t available or you prefer to create your own, this guide will help you implement a custom driver using TranJS’s core package.

## Step 1: Install Core Package

Begin by installing only the core TranJS package:

```bash
npm install @tranjs/core --save
```

## Step 2: Extend PlatformTransactionManager

TranJS provides an abstract class, `PlatformTransactionManager`, which you must extend to implement your custom transaction management logic.

Below is an example implementation:

```typescript
import {
    PlatformTransactionManager,
    TransactionContext,
    Propagation,
    AsyncLocal,
} from '@tranjs/core';

class CustomDatabaseConnection implements TransactionContext {
    constructor(
        public readonly connection: any,
    ) {}

    async execute(query: string, params: any[]): Promise<any> {
        // Implement your logic to execute the query with the given parameters.
    }
}

class CustomDriverTransactionManager extends PlatformTransactionManager<CustomDatabaseConnection> {
    protected constructor(...args: any[]) { // Implement constructor
        super();
    }

    protected async beginTransaction(): Promise<TransactionContext> {
        console.log('Custom Begin Transaction');
        // Implement your logic to initialize and return a new transaction context.
        const tx: TransactionContext = { /* ...initialize transaction context... */};
        return tx;
    }

    protected async commitTransaction(tx: TransactionContext): Promise<void> {
        console.log('Custom Commit Transaction');
        // Implement commit operation for the transaction.
    }

    protected async rollbackTransaction(tx: TransactionContext): Promise<void> {
        console.log('Custom Rollback Transaction');
        // Implement rollback operation for the transaction.
    }
}
```