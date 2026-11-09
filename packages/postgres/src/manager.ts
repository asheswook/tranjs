import postgres from "postgres";
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
import { TransactionSql } from "./context";
import { TransactionAbortedError } from "./errors";

const DRIVER_NAME = Symbol("postgres");

export type PostgresConnectionConfig = string | postgres.Options<{}>;
export type PostgresConnectionConfigSource = PostgresConnectionConfig |
    (() => PostgresConnectionConfig | Promise<PostgresConnectionConfig>);

export function usePostgresTransactionManager(sql: postgres.Sql, name?: string | symbol) {
    useTransactionManager(new PostgresTransactionManager(sql), name);
}

/** Register once at module scope; the config factory is resolved per physical transaction. */
export function usePostgresConnectionPerTransaction(config: PostgresConnectionConfigSource, name?: string | symbol) {
    useTransactionManager(new PostgresConnectionPerTransactionManager(config), name);
}

export const ctx = (datasource?: string | symbol): TransactionSql => {
    const manager = getTransactionManager(datasource);
    if (!(manager instanceof PostgresTransactionManager) && !(manager instanceof PostgresConnectionPerTransactionManager)) {
        throw new TransactionContextMixingError(manager.constructor.name, DRIVER_NAME);
    }
    const transaction = manager.getCurrentTransaction();
    if (!transaction) throw new Error("Transaction context not initialized");
    return manager.wrapConnection(transaction);
};

abstract class PostgresManagerBase extends PlatformTransactionManager<TransactionSql> {
    private readonly wrappers = new WeakMap<TransactionSql, TransactionSql>();
    private readonly queries = new WeakMap<object, object>();

    public checkDeadline(): number | undefined { return this.getRemainingTimeout(); }

    public wrapConnection(connection: TransactionSql): TransactionSql {
        const cached = this.wrappers.get(connection);
        if (cached) return cached;
        const wrapper = new Proxy(connection, {
            apply: (target, receiver, args) => {
                this.checkDeadline();
                return this.wrapQuery(Reflect.apply(target, receiver, args));
            },
            get: (target, property) => {
                const value = Reflect.get(target, property, target);
                if (property === "unsafe" || property === "file") return (...args: any[]) => {
                    this.checkDeadline();
                    return this.wrapQuery(value.apply(target, args));
                };
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
        this.wrappers.set(connection, wrapper);
        return wrapper;
    }

    private wrapQuery(query: any): any {
        // sql(identifier), sql(object), etc. are helpers, not executable queries.
        if (!query || typeof query.then !== "function" || typeof query.cancel !== "function") return query;
        const cached = this.queries.get(query);
        if (cached) return cached;
        let execution: Promise<any> | undefined;
        const execute = () => {
            if (execution) return execution;
            const remaining = this.checkDeadline();
            let fired = false;
            const timer = remaining === undefined ? undefined : setTimeout(() => {
                fired = true;
                // Cancellation opens its own connection and can fail independently.
                // Preserve the query's actual error rather than leaking a timer rejection.
                try { Promise.resolve(query.cancel()).catch(() => {}); } catch {}
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
                if (property === "then") return (...args: any[]) => execute().then(...args);
                if (property === "catch") return (...args: any[]) => execute().catch(...args);
                if (property === "finally") return (...args: any[]) => execute().finally(...args);
                if (property === "execute") return () => { execute(); return wrapper; };
                const value = Reflect.get(target, property, target);
                if (typeof value !== "function") return value;
                // These APIs own their cursor/stream lifecycle. Check before dispatch,
                // but do not arm cancellation or intercept their results or callbacks.
                if (["cursor", "forEach", "stream", "readable", "writable"].includes(String(property))) {
                    return (...args: any[]) => {
                        this.checkDeadline();
                        return value.apply(target, args);
                    };
                }
                return (...args: any[]) => {
                    const result = value.apply(target, args);
                    return result === target ? wrapper : this.wrapQuery(result);
                };
            },
        });
        this.queries.set(query, wrapper);
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

    protected async commitTransaction(tx: TransactionSql): Promise<void> {
        const result = await tx.unsafe("COMMIT");
        if (result.command === "ROLLBACK") throw new TransactionAbortedError();
    }

    protected async rollbackTransaction(tx: TransactionSql): Promise<void> {
        await tx.unsafe("ROLLBACK");
    }

    protected async createSavepoint(tx: TransactionSql, name: string): Promise<void> {
        await tx.unsafe(`SAVEPOINT ${name}`);
    }

    protected async rollbackToSavepoint(tx: TransactionSql, name: string): Promise<void> {
        await tx.unsafe(`ROLLBACK TO SAVEPOINT ${name}`);
    }

    protected async releaseSavepoint(tx: TransactionSql, name: string): Promise<void> {
        await tx.unsafe(`RELEASE SAVEPOINT ${name}`);
    }
}

export class PostgresTransactionManager extends PostgresManagerBase {
    constructor(private readonly sql: postgres.Sql) { super(); }

    protected async beginTransaction(options?: TransactionOptions): Promise<MetadataWrappedTransaction<TransactionSql>> {
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

    protected async releaseTransaction(tx: TransactionSql, _failed: boolean): Promise<void> {
        // No public discard API. postgres.js closes broken connections itself;
        // release also closes a connection still in a non-idle transaction state.
        tx.release();
    }
}

/** A one-connection postgres.js instance per physical transaction, for Workers + Hyperdrive. */
export class PostgresConnectionPerTransactionManager extends PostgresManagerBase {
    private readonly pools = new WeakMap<TransactionSql, postgres.Sql>();
    private readonly ended = new WeakSet<TransactionSql>();
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

    protected async beginTransaction(options?: TransactionOptions): Promise<MetadataWrappedTransaction<TransactionSql>> {
        const begin = this.beginSql(options);
        const config = typeof this.config === "function" ? await this.config() : this.config;
        const sql = typeof config === "string" ? postgres(config, { max: 1 }) : postgres({ ...config, max: 1 });
        let connection: TransactionSql;
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

    protected async releaseTransaction(tx: TransactionSql, _failed: boolean): Promise<void> {
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
