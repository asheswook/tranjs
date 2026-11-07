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
    MetadataWrappedTransaction,
    PlatformTransactionManager,
    TransactionContext,
    TransactionOptions,
} from '@tranjs/core';

interface CustomConnection extends TransactionContext {
    query(sql: string, params?: any[]): Promise<any>;
}

const DRIVER_NAME = Symbol('custom');

class CustomDriverTransactionManager extends PlatformTransactionManager<CustomConnection> {
    // Opt in because commitTransaction below handles rollback and release itself.
    protected readonly handlesCommitFailure = true;

    constructor(private readonly pool: any) {
        super();
    }

    // Required
    protected async beginTransaction(options?: TransactionOptions): Promise<MetadataWrappedTransaction<CustomConnection>> {
        const connection = await this.pool.getConnection();
        try {
            // Apply options.isolationLevel / options.readOnly / options.timeout as your DB supports them.
            await connection.query('BEGIN');
        } catch (error) {
            connection.release();   // release the connection if begin fails
            throw error;
        }
        return { transaction: connection, metadata: { driverName: DRIVER_NAME } };
    }

    // Required. With handlesCommitFailure = true, handle failed-commit cleanup here.
    protected async commitTransaction(tx: CustomConnection): Promise<void> {
        try {
            await tx.query('COMMIT');
        } catch (error) {
            try { await tx.query('ROLLBACK'); } catch {}
            throw error;
        } finally {
            (tx as any).release();
        }
    }

    // Required
    protected async rollbackTransaction(tx: CustomConnection): Promise<void> {
        try {
            await tx.query('ROLLBACK');
        } finally {
            (tx as any).release();
        }
    }

    // Optional: implement only if you support Propagation.NESTED. Otherwise it throws NestedTransactionNotSupportedError.
    protected async createSavepoint(tx: CustomConnection, name: string) { await tx.query(`SAVEPOINT ${name}`); }
    protected async rollbackToSavepoint(tx: CustomConnection, name: string) { await tx.query(`ROLLBACK TO SAVEPOINT ${name}`); }
    protected async releaseSavepoint(tx: CustomConnection, name: string) { await tx.query(`RELEASE SAVEPOINT ${name}`); }
}
```

Read the current transaction with `manager.getCurrentTransaction()`. Like the native drivers, you can expose a type-safe `ctx()` based on it.

By default, `protected readonly handlesCommitFailure: boolean = false` preserves legacy behavior: when commit throws, core calls `rollbackTransaction`, logs any rollback error, and rethrows the original commit error. Set it to `true` only if your commit method already rolls back and releases (or disposes of) the connection on failure, as in the example. Core runs `afterRollback` hooks in either mode. Never return a connection to the pool after a failed rollback; destroy it instead.

## Step 3: Use Your Custom Driver

After implementing your custom driver, you can use it in your application by calling `useTransactionManager` with an instance of your custom driver:

```typescript
import { useTransactionManager } from '@tranjs/core';

useTransactionManager(new CustomDriverTransactionManager(pool));
// or register under a name: useTransactionManager(manager, "secondary");
```

That’s it! You’ve successfully implemented a custom driver for TranJS.
