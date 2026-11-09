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
    constructor(private readonly pool: any) {
        super();
    }

    // Required
    protected async beginTransaction(options?: TransactionOptions): Promise<MetadataWrappedTransaction<CustomConnection>> {
        const connection = await this.pool.getConnection();
        try {
            // Apply options.isolationLevel / options.readOnly as your DB supports them.
            await connection.query('BEGIN');
        } catch (error) {
            // Begin owns its cleanup because core has not received the connection yet.
            try { await connection.query('ROLLBACK'); connection.release(); }
            catch { connection.destroy(); }
            throw error;
        }
        return { transaction: connection, metadata: { driverName: DRIVER_NAME } };
    }

    // Required: only send COMMIT. Core never calls rollback after a commit failure.
    protected async commitTransaction(tx: CustomConnection): Promise<void> {
        await tx.query('COMMIT');
    }

    // Required
    protected async rollbackTransaction(tx: CustomConnection): Promise<void> {
        await tx.query('ROLLBACK');
    }

    // Optional (default no-op). Called exactly once in core's finally block.
    protected async releaseTransaction(tx: CustomConnection, failed: boolean): Promise<void> {
        if (failed) (tx as any).destroy();
        else (tx as any).release();
    }

    // Expose this for a ctx() query wrapper to check before each query.
    public checkDeadline(): number | undefined {
        return this.getRemainingTimeout();
    }

    // Optional: implement only if you support Propagation.NESTED. Otherwise it throws NestedTransactionNotSupportedError.
    protected async createSavepoint(tx: CustomConnection, name: string) { await tx.query(`SAVEPOINT ${name}`); }
    protected async rollbackToSavepoint(tx: CustomConnection, name: string) { await tx.query(`ROLLBACK TO SAVEPOINT ${name}`); }
    protected async releaseSavepoint(tx: CustomConnection, name: string) { await tx.query(`RELEASE SAVEPOINT ${name}`); }
}
```

Read the current transaction with `manager.getCurrentTransaction()`. Like the native drivers, you can expose a type-safe `ctx()` based on it.

The lifecycle is begin → callback → commit or rollback → completion hooks → `releaseTransaction` in a `finally` block. `failed` is true only when commit or rollback throws (an application error with successful rollback gives `false`). `afterCommit` hooks run sequentially, stopping at the first error and propagating it; the transaction remains committed, no rollback or `afterRollback` hooks run, and release is called once with `failed=false`. `afterRollback` errors are logged and swallowed. Never return a connection with an uncertain completion outcome to the pool; dispose of it instead. Begin failures must clean up within `beginTransaction` itself. Keep release hooks reliable: a thrown cleanup error can replace the pending error.

Core never calls rollback after a commit failure; it runs `afterRollback` hooks and rethrows the commit error. When physical rollback fails, core logs the original error and throws `TransactionSystemError` with the rollback error as `cause` and the original as `applicationError`.

Existing published drivers that release inside commit/rollback can keep doing so with the default no-op release hook: core will not roll back after failed commit and double-release. When migrating, move cleanup to `releaseTransaction` and remove it from commit/rollback; never do both.

Core manages savepoint rollback-only state: a successful `NESTED` rollback to a savepoint clears the entire `rollbackOnly` flag, including preexisting state. A nested callback that returns while rollback-only causes savepoint rollback, flag clearing, and `UnexpectedRollbackError`; the outer callback can catch it and commit, unless the owner's deadline check fails.

For deadlines, `timeout` must be finite, nonnegative, and no greater than `2147483647` ms. Expose `getRemainingTimeout()` through a public method and call it immediately before each query in your type-safe `ctx()` wrapper. Pass its remaining milliseconds to the driver’s per-query timeout, always overriding user timeouts and pool defaults (including shorter values), while preserving other query arguments. It returns `undefined` without a deadline; leave user options untouched in that case. Once expired it marks rollback-only and throws `TransactionTimeoutError`. Bind other methods to the real connection. Core also checks the deadline before commit, but cannot interrupt arbitrary callback code. Native drivers show Proxy-based examples.

The native PostgreSQL wrapper treats Submittables (`pg.Query`, `pg-query-stream`, `pg-cursor`) specially: check the deadline only before dispatch and pass them through untouched, without per-query timeout injection or interception. Streams must be consumed inside the transactional callback; the owner still checks the deadline before commit.

## Step 3: Use Your Custom Driver

After implementing your custom driver, you can use it in your application by calling `useTransactionManager` with an instance of your custom driver:

```typescript
import { useTransactionManager } from '@tranjs/core';

useTransactionManager(new CustomDriverTransactionManager(pool));
// or register under a name: useTransactionManager(manager, "secondary");
```

That’s it! You’ve successfully implemented a custom driver for TranJS.
