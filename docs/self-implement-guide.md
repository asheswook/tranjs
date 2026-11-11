# Custom drivers

A custom driver connects TranJS to a database client that the bundled drivers (`@tranjs/pg`, `@tranjs/postgres`, `@tranjs/mysql2`) do not cover.

```bash
# A custom driver depends only on the core package.
npm install @tranjs/core
```

## Minimal manager

A driver is a subclass of `PlatformTransactionManager<Tx>`. `beginTransaction`, `commitTransaction` and `rollbackTransaction` are abstract. Begin returns the connection and its driver metadata. The example assumes a pool with the interface below and PostgreSQL-style transaction SQL.

```typescript
// Example manager for a hypothetical pooled driver with PostgreSQL-style transaction SQL.
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
    manager.assertCurrentTransactionOpen();
    const tx = manager.getCurrentTransaction();
    if (!tx) throw new NoTransactionContextError();
    return tx;
}
```

After `register(pool, name?)` has run, `@Transactional` and `transactional` use this manager. `getCurrentTransaction()` returns `Tx | undefined`, so a driver can expose a typed `ctx()` without using the deprecated core `ctx()`.

The example's `ctx()` looks its manager up by name, so an omitted name means the default datasource. The bundled drivers select the innermost active transaction instead; see [datasource selection](api.md#datasource-selection).

`manager.assertCurrentTransactionOpen()` makes `ctx()` throw `TransactionClosedError` after the transaction ends. A connection kept from `ctx()` is not covered; the bundled drivers wrap it for the [connection lifetime check](drivers.md#connection-lifetime).

`withTestTransaction` needs all three savepoint methods: `createSavepoint`, `rollbackToSavepoint`, and `releaseSavepoint`. Only the bundled drivers support `withTestConnection` and its `TestConnection` type.

## Connection cleanup

The lifecycle is begin → callback → commit or rollback → completion hooks → `releaseTransaction(tx, failed)` in a `finally` block. The release hook is optional (a no-op by default) and is called exactly once after a successful begin, even if a completion hook throws. It is the only point that runs on every path after a successful begin, which makes it the place for connection cleanup.

`failed` is true only if physical commit or rollback throws. An application error followed by successful rollback gives `false`; an `afterCommit` error also gives `false`. When `failed` is true the connection may still be inside the transaction. Returned to a pool in that state, its next user inherits the open transaction. If `beginTransaction` throws, core never sees the connection and `releaseTransaction` is not called for it. An error thrown from `releaseTransaction` replaces the transaction's own error.

Core does not call rollback after commit failure. For error precedence, completion hooks, and logging, see the [API rollback rules](api.md#rollback-rules) and [hooks](api.md#hooks).

## Optional savepoints

`NESTED` inside a transaction uses `createSavepoint`, `rollbackToSavepoint` and `releaseSavepoint`. The defaults throw `NestedTransactionNotSupportedError`. Example that builds on the manager above:

```typescript
// Partial example: extends CustomTransactionManager and Connection from the manager example above.
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

The minimal `ctx()` above returns the raw connection. Core checks deadlines before commit, but query-level enforcement needs a wrapper. The [bundled driver wrappers](../packages/pg/src/manager.ts) are examples.

`getRemainingTimeout()` is protected. The bundled drivers expose it through a public method and call it before each query. It returns the remaining milliseconds, or `undefined` without a deadline; on expiry it marks rollback-only and throws `TransactionTimeoutError`. The bundled drivers then pass the remaining time as the driver's per-query timeout, replacing any user or pool timeout, including a shorter one. That is their choice, not a core rule: a custom driver can take the smaller of the two. Without a deadline they leave the query options untouched. Their wrappers bind every other connection method to the real connection.

When that injected timer fires, the protected `expireTransaction()` marks the transaction rollback-only and returns a `TransactionTimeoutError` without rechecking the clock: timers can fire just before `Date.now()` reaches the deadline. It returns `undefined` without a deadline.

See [deadline limits and client-side semantics](api.md#deadlines), including `pg` Submittable handling. Core validates `isolationLevel` and `timeout` and passes the options to `beginTransaction` unchanged. Applying, ignoring or rejecting `isolationLevel` and `readOnly` is the driver's decision.
