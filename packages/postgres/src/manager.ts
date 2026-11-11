import type postgres from "postgres" with { "resolution-mode": "import" };
import {
    getTransactionManager,
    InvalidIsolationLevelError,
    IsolationLevel,
    Logger,
    MetadataWrappedTransaction,
    PlatformTransactionManager,
    TransactionContextMixingError,
    TransactionOptions,
    useTransactionManager,
} from "@tranjs/core";
import { ReservedTransactionSql, TransactionSql } from "./context";
import { TransactionAbortedError } from "./errors";
import type { TestConnectionLease } from "@tranjs/core/internal/testing-bridge";
import { createPostgresTestConnection } from "./test-connection";
import type { TestConnection } from "./test-connection";

const DRIVER_NAME = Symbol("postgres");

let factory: Promise<typeof postgres> | undefined;
function loadPostgres(): Promise<typeof postgres> {
    // Keep this native import visible to Workers bundlers and usable from CJS
    // on Node 18, without relying on synchronous require(ESM) support.
    return factory ??= import("postgres").then(module => module.default);
}

export type PostgresConnectionConfig = string | postgres.Options<{}>;
export type PostgresConnectionConfigSource = PostgresConnectionConfig |
    (() => PostgresConnectionConfig | Promise<PostgresConnectionConfig>);

// v3's ReservedSql incorrectly extends the pool's Sql interface. A reservation
// still isn't a pool and cannot be used to reserve another transaction.
type PostgresPool = postgres.Sql & { readonly release?: never };

export function usePostgresTransactionManager(sql: PostgresPool, name?: string | symbol) {
    useTransactionManager(new PostgresTransactionManager(sql), name);
}

/** Register once at module scope; the config factory is resolved per physical transaction. */
export function usePostgresConnectionPerTransaction(config: PostgresConnectionConfigSource, name?: string | symbol) {
    useTransactionManager(new PostgresConnectionPerTransactionManager(config), name);
}

// Symbol.dispose / asyncDispose may be missing on older runtimes; filter them out.
const HIDDEN_MEMBERS = new Set<PropertyKey>(
    ["begin", "reserve", "end", "close", "listen", "subscribe", "largeObject", "release",
        (Symbol as any).dispose, (Symbol as any).asyncDispose].filter((key): key is PropertyKey => key !== undefined),
);

export function ctx<T extends Record<string, unknown> = {}>(datasource?: string | symbol): TransactionSql<T>;
export function ctx(datasource?: string | symbol): TransactionSql;
export function ctx(datasource?: string | symbol): TransactionSql {
    const manager = getTransactionManager(datasource);
    if (!(manager instanceof PostgresTransactionManager) && !(manager instanceof PostgresConnectionPerTransactionManager)) {
        throw new TransactionContextMixingError(manager.constructor.name, DRIVER_NAME);
    }
    manager.assertCurrentTransactionOpen();
    const transaction = manager.getCurrentTransaction();
    if (!transaction) throw new Error("Transaction context not initialized");
    return manager.wrapConnection(transaction);
}

abstract class PostgresManagerBase extends PlatformTransactionManager<ReservedTransactionSql> {
    protected createTestConnection(tx: ReservedTransactionSql, lease: TestConnectionLease): TestConnection {
        return createPostgresTestConnection(tx, lease);
    }

    protected testTransactionCommitError(cause: unknown): unknown {
        if ((cause as { code?: string })?.code === "25P02") {
            return Object.assign(new TransactionAbortedError(), { cause });
        }
        return cause;
    }

    private readonly wrappers = new WeakMap<object, TransactionSql>();
    private readonly queries = new WeakMap<object, WeakMap<object, object>>();
    private readonly nativeQueries = new WeakMap<object, object>();
    private readonly queryGuards = new WeakMap<object, { gate: object; assertOpen: () => void }>();

    public checkDeadline(): number | undefined { return this.getRemainingTimeout(); }

    public wrapConnection(connection: ReservedTransactionSql): TransactionSql {
        const gate = this.getConnectionGate(connection);
        const assertOpen = () => this.assertConnectionOpen(gate);
        assertOpen();
        const cached = this.wrappers.get(gate);
        if (cached) return cached;
        const wrapQuery = (query: any) => this.wrapQuery(query, assertOpen, gate);
        const unwrapPart = (part: any) => {
            const guard = part && (typeof part === "object" || typeof part === "function")
                ? this.queryGuards.get(part) : undefined;
            if (guard) {
                guard.assertOpen();
                if (guard.gate !== gate) throw new Error("Cannot batch queries from another transaction");
            }
            return this.nativeQueries.get(part) ?? part;
        };
        const wrapper = new Proxy(connection, {
            apply: (target, receiver, args) => {
                assertOpen();
                this.checkDeadline();
                return wrapQuery(Reflect.apply(target, receiver, args));
            },
            has: (target, property) => !HIDDEN_MEMBERS.has(property) && Reflect.has(target, property),
            get: (target, property) => {
                // TranJS releases the connection when the transaction ends; releasing it
                // from user code (including `using`) would break the commit.
                if (HIDDEN_MEMBERS.has(property)) return undefined;
                const value = Reflect.get(target, property, target);
                if (property === "notify") {
                    // Native notify() awaits an internal query; issue the same statement
                    // through the wrapper so it gets the deadline check and cancellation.
                    return (channel: string, payload: string) =>
                        wrapper`select pg_notify(${channel}, ${"" + payload})`.then(() => undefined);
                }
                // Inherited bind/valueOf methods must receive the proxy, not the native SQL function.
                if (!Object.prototype.hasOwnProperty.call(target, property)) return value;
                // Pure serializer helpers must retain their identity and custom properties.
                if (property === "typed" || property === "types") return value;
                if (typeof value === "function") return new Proxy(value, {
                    apply: (fn, _receiver, args) => {
                        assertOpen();
                        this.checkDeadline();
                        if (property === "batch" && Array.isArray(args[0])) {
                            // postgres.js settles/handles each part internally. Give it
                            // native queries so its own catch handlers cannot hit an
                            // expired wrapper deadline while settling a failed batch.
                            args[0] = args[0].map(unwrapPart);
                        }
                        return wrapQuery(Reflect.apply(fn, target, args));
                    },
                });
                // ReservedSql helpers are closure-based, not this-dependent methods.
                // In particular typed/types carry custom serializer properties and
                // share identity; binding them would erase those properties.
                return value;
            },
        });
        // The proxy hides the managed members at runtime, which is what TransactionSql describes.
        const publicWrapper = wrapper as unknown as TransactionSql;
        this.wrappers.set(gate, publicWrapper);
        return publicWrapper;
    }

    private wrapQuery(query: any, assertOpen: () => void, gate: object): any {
        // sql(identifier), sql(object), etc. are helpers, not executable queries.
        if (!query || typeof query.then !== "function" || typeof query.cancel !== "function") return query;
        let queries = this.queries.get(gate);
        if (!queries) this.queries.set(gate, queries = new WeakMap());
        const cached = queries.get(query);
        if (cached) return cached;
        let execution: Promise<any> | undefined;
        let dispatched = false;
        const nativeHandle = query.handle;
        if (typeof nativeHandle === "function") query.handle = function (...args: any[]) {
            if (!query.executed) {
                assertOpen();
                dispatched = true;
            }
            return Reflect.apply(nativeHandle, this, args);
        };
        const nativeCancel = query.cancel;
        query.cancel = function (...args: any[]) {
            assertOpen();
            return Reflect.apply(nativeCancel, this, args);
        };
        const execute = () => {
            if (execution) return execution;
            // Attaching another consumer to an already dispatched query is safe;
            // Only starting new database work requires an open connection.
            if (!dispatched) assertOpen();
            const remaining = dispatched ? undefined : this.checkDeadline();
            dispatched = true;
            let fired = false;
            const timer = remaining === undefined ? undefined : setTimeout(() => {
                fired = true;
                // Cancellation opens its own connection and can fail independently.
                // Preserve the query's actual error rather than leaking a timer rejection.
                try { assertOpen(); Promise.resolve(query.cancel()).catch(() => {}); } catch {}
            }, remaining);
            const clear = () => { if (timer !== undefined) clearTimeout(timer); };
            execution = query.then((result: unknown) => {
                clear();
                return result;
            }, (error: any) => {
                clear();
                if (fired && error?.code === "57014") throw this.expireTransaction() ?? error;
                throw error;
            });
            // execute() may be called before a consumer attaches its then/catch.
            execution!.catch(() => {});
            return execution!;
        };
        const wrapper = new Proxy(query, {
            get: (target, property) => {
                const value = Reflect.get(target, property, target);
                if (typeof value !== "function") return value;
                // Callable proxies retain any properties on the original function.
                return new Proxy(value, {
                    apply: (fn, _receiver, args) => {
                        if (property === "then") return execute().then(...args);
                        if (property === "catch") return execute().catch(...args);
                        if (property === "finally") return execute().finally(...args);
                        if (property === "execute") { execute(); return wrapper; }
                        assertOpen();
                        // These APIs own their cursor/stream lifecycle. Check before
                        // dispatch, without cancellation or result interception.
                        if (["cursor", "forEach", "stream", "readable", "writable"].includes(String(property))) {
                            this.checkDeadline();
                            if (property !== "cursor") dispatched = true;
                            const result: any = Reflect.apply(fn, target, args);
                            if (result === target) return target;
                            // cursor() without a callback dispatches on the first
                            // iterator.next(), not when the cursor is constructed.
                            if (property === "cursor" && result?.[Symbol.asyncIterator]) {
                                return new Proxy(result, {
                                    get: (cursor, key) => key === Symbol.asyncIterator ? () => {
                                        const iterator = cursor[Symbol.asyncIterator]();
                                        return new Proxy(iterator, {
                                            get: (native, method) => {
                                                const member = Reflect.get(native, method, native);
                                                if (typeof member !== "function") return member;
                                                return (...iteratorArgs: any[]) => {
                                                    if (method === "next" && !dispatched) {
                                                        assertOpen();
                                                        this.checkDeadline();
                                                        dispatched = true;
                                                    }
                                                    return Reflect.apply(member, native, iteratorArgs);
                                                };
                                            },
                                        });
                                    } : Reflect.get(cursor, key, cursor),
                                });
                            }
                            return result;
                        }
                        const result = Reflect.apply(fn, target, args);
                        return result === target ? wrapper : this.wrapQuery(result, assertOpen, gate);
                    },
                });
            },
        });
        queries.set(query, wrapper);
        this.nativeQueries.set(wrapper, query);
        this.queryGuards.set(query, { gate, assertOpen });
        this.queryGuards.set(wrapper, { gate, assertOpen });
        return wrapper;
    }

    protected beginSql(options?: TransactionOptions): string {
        if (options?.isolationLevel !== undefined && !Object.values(IsolationLevel).includes(options.isolationLevel)) {
            throw new InvalidIsolationLevelError(options.isolationLevel);
        }
        let sql = "BEGIN";
        if (options?.isolationLevel) sql += ` ISOLATION LEVEL ${options.isolationLevel}`;
        if (options?.readOnly) sql += " READ ONLY";
        return sql;
    }

    protected async commitTransaction(tx: ReservedTransactionSql): Promise<void> {
        const result = await tx.unsafe("COMMIT");
        if (result.command === "ROLLBACK") throw new TransactionAbortedError();
    }

    protected async rollbackTransaction(tx: ReservedTransactionSql): Promise<void> {
        await tx.unsafe("ROLLBACK");
    }

    protected async checkTestTransactionConstraints(tx: ReservedTransactionSql, name: string): Promise<void> {
        await this.createSavepoint(tx, name);
        this.assertTransactionConnectionOpen(tx);
        await tx.unsafe("SET CONSTRAINTS ALL IMMEDIATE");
        // Restore the exact constraint modes, including application overrides.
        await this.rollbackToSavepoint(tx, name);
        await this.releaseSavepoint(tx, name);
    }

    protected async createSavepoint(tx: ReservedTransactionSql, name: string): Promise<void> {
        this.assertTransactionConnectionOpen(tx);
        await tx.unsafe(`SAVEPOINT ${name}`);
    }

    protected async rollbackToSavepoint(tx: ReservedTransactionSql, name: string): Promise<void> {
        this.assertTransactionConnectionOpen(tx);
        await tx.unsafe(`ROLLBACK TO SAVEPOINT ${name}`);
    }

    protected async releaseSavepoint(tx: ReservedTransactionSql, name: string): Promise<void> {
        this.assertTransactionConnectionOpen(tx);
        await tx.unsafe(`RELEASE SAVEPOINT ${name}`);
    }
}

export class PostgresTransactionManager extends PostgresManagerBase {
    constructor(private readonly sql: PostgresPool) { super(); }

    protected async beginTransaction(options?: TransactionOptions): Promise<MetadataWrappedTransaction<ReservedTransactionSql>> {
        const begin = this.beginSql(options);
        const connection = await this.sql.reserve();
        try {
            await connection.unsafe(begin);
            return { metadata: { driverName: DRIVER_NAME }, transaction: connection };
        } catch (error) {
            // BEGIN may have reached the server before the reported failure.
            try { await connection.unsafe("ROLLBACK"); } catch {}
            connection.release();
            throw error;
        }
    }

    protected async releaseTransaction(tx: ReservedTransactionSql, _failed: boolean): Promise<void> {
        // postgres.js owns the reservation's release and connection disposal behavior.
        tx.release();
    }
}

/** A one-connection postgres.js instance per physical transaction, for Workers + Hyperdrive. */
export class PostgresConnectionPerTransactionManager extends PostgresManagerBase {
    private readonly pools = new WeakMap<ReservedTransactionSql, postgres.Sql>();
    private readonly ended = new WeakSet<ReservedTransactionSql>();
    private cleanupLogger: Logger = console;

    constructor(private readonly config: PostgresConnectionConfigSource) { super(); }

    public setLogger(logger: Logger): void {
        super.setLogger(logger);
        this.cleanupLogger = logger;
    }

    private logCleanup(error: unknown): void {
        try { this.cleanupLogger.error("Postgres connection cleanup failed", error); } catch {}
    }

    private async end(sql: postgres.Sql): Promise<void> {
        try { await sql.end({ timeout: 1 }); }
        catch (error) { this.logCleanup(error); }
    }

    protected async beginTransaction(options?: TransactionOptions): Promise<MetadataWrappedTransaction<ReservedTransactionSql>> {
        const begin = this.beginSql(options);
        const config = typeof this.config === "function" ? await this.config() : this.config;
        const postgres = await loadPostgres();
        const sql = typeof config === "string" ? postgres(config, { max: 1 }) : postgres({ ...config, max: 1 });
        let connection: ReservedTransactionSql;
        try { connection = await sql.reserve(); }
        catch (error) {
            await this.end(sql);
            throw error;
        }
        this.pools.set(connection, sql);
        try {
            await connection.unsafe(begin);
            return { metadata: { driverName: DRIVER_NAME }, transaction: connection };
        } catch (error) {
            try { await connection.unsafe("ROLLBACK"); } catch {}
            await this.releaseTransaction(connection, true);
            throw error;
        }
    }

    protected async releaseTransaction(tx: ReservedTransactionSql, _failed: boolean): Promise<void> {
        if (this.ended.has(tx)) return;
        this.ended.add(tx);
        try { tx.release(); }
        catch (error) { this.logCleanup(error); }
        finally {
            const sql = this.pools.get(tx);
            this.pools.delete(tx);
            if (sql) await this.end(sql);
        }
    }
}
