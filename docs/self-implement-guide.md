# Implement a driver

```bash
npm install @tranjs/core
```

## Minimal manager

Extend `PlatformTransactionManager<Tx>` and implement begin, commit, and rollback. Begin returns the connection and its driver metadata. This example assumes a pool with the interface below and PostgreSQL-compatible transaction SQL; adapt acquisition and SQL to your database.

```typescript
import {
    getTransactionManager,
    MetadataWrappedTransaction,
    NoTransactionContextError,
    PlatformTransactionManager,
    TransactionContext,
    TransactionContextMixingError,
    TransactionOptions,
    useTransactionManager,
} from "@tranjs/core";

interface Connection extends TransactionContext {
    query(sql: string): Promise<unknown>;
    release(): void;
    destroy(): void;
}

interface ConnectionPool {
    getConnection(): Promise<Connection>;
}

const DRIVER_NAME = Symbol("custom");

class CustomTransactionManager extends PlatformTransactionManager<Connection> {
    constructor(private readonly pool: ConnectionPool) {
        super();
    }

    protected async beginTransaction(
        options?: TransactionOptions,
    ): Promise<MetadataWrappedTransaction<Connection>> {
        const connection = await this.pool.getConnection();
        try {
            let sql = "BEGIN";
            if (options?.isolationLevel) sql += ` ISOLATION LEVEL ${options.isolationLevel}`;
            if (options?.readOnly) sql += " READ ONLY";
            await connection.query(sql);
            return { transaction: connection, metadata: { driverName: DRIVER_NAME } };
        } catch (error) {
            // Core has not received this connection, so begin owns its cleanup.
            try {
                await connection.query("ROLLBACK");
                connection.release();
            } catch {
                connection.destroy();
            }
            throw error;
        }
    }

    protected async commitTransaction(tx: Connection): Promise<void> {
        await tx.query("COMMIT");
    }

    protected async rollbackTransaction(tx: Connection): Promise<void> {
        await tx.query("ROLLBACK");
    }

    protected async releaseTransaction(tx: Connection, failed: boolean): Promise<void> {
        if (failed) tx.destroy();
        else tx.release();
    }
}

function register(pool: ConnectionPool, name?: string | symbol): void {
    useTransactionManager(new CustomTransactionManager(pool), name);
}

function ctx(datasource?: string | symbol): Connection {
    const manager = getTransactionManager(datasource);
    if (!(manager instanceof CustomTransactionManager)) {
        throw new TransactionContextMixingError(manager.constructor.name, DRIVER_NAME);
    }
    const tx = manager.getCurrentTransaction();
    if (!tx) throw new NoTransactionContextError();
    return tx;
}
```

Call `register(pool, name?)` once at module scope, then use `@Transactional` or `runInTransaction`. `getCurrentTransaction()` returns `Tx | undefined`, so a driver can expose a typed `ctx()` without using the deprecated core `ctx()`.

## Connection cleanup

The lifecycle is begin → callback → commit or rollback → completion hooks → `releaseTransaction(tx, failed)` in a `finally` block. The release hook is optional (a no-op by default) and is called exactly once after a successful begin, even if a completion hook throws. Put connection cleanup there, not in commit or rollback.

`failed` is true only if physical commit or rollback throws. An application error followed by successful rollback gives `false`; an `afterCommit` error also gives `false`. Dispose of connections with uncertain completion outcomes rather than returning them to a pool. Begin failures must clean up within `beginTransaction`, because core has not received the connection yet. Keep release reliable: a thrown cleanup error can replace a pending error.

Core does not call rollback after commit failure. For error precedence, completion hooks, and logging, see the [API rollback rules](api.md#rollback-rules) and [hooks](api.md#hooks).

## Optional savepoints

Implement all three savepoint methods to support `NESTED` inside a transaction. Otherwise the default methods throw `NestedTransactionNotSupportedError`. Building on the manager above:

```typescript
class SavepointTransactionManager extends CustomTransactionManager {
    protected async createSavepoint(tx: Connection, name: string): Promise<void> {
        await tx.query(`SAVEPOINT ${name}`);
    }

    protected async rollbackToSavepoint(tx: Connection, name: string): Promise<void> {
        await tx.query(`ROLLBACK TO SAVEPOINT ${name}`);
    }

    protected async releaseSavepoint(tx: Connection, name: string): Promise<void> {
        await tx.query(`RELEASE SAVEPOINT ${name}`);
    }
}
```

Core generates savepoint names and manages rollback-only state, including the [reset after successful savepoint rollback](api.md#rollback-rules).

## Query deadlines

The minimal `ctx()` above returns the raw connection. Core checks deadlines before commit, but query-level enforcement needs a wrapper. The [native driver wrappers](../packages/pg/src/manager.ts) provide examples.

Expose protected `getRemainingTimeout()` through a public manager method and call it immediately before each query. It returns the remaining milliseconds, or `undefined` without a deadline; on expiry it marks rollback-only and throws `TransactionTimeoutError`. Inject the remaining time into the driver's per-query timeout, preserving other arguments and overriding user timeouts and pool defaults, including shorter values. Leave options untouched when no deadline exists. Bind other connection methods to the real connection.

If that injected timer fires, use protected `expireTransaction()` to mark rollback-only and obtain a `TransactionTimeoutError` without rechecking the clock: timers can fire just before `Date.now()` reaches the deadline. It returns `undefined` without a deadline.

See [deadline limits and client-side semantics](api.md#deadlines), including PostgreSQL Submittable handling. Implement or reject isolation and read-only options according to the database's capabilities.
