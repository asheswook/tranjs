import { Pool, PoolClient as NativeClient, Query } from "pg";
import QueryStream = require("pg-query-stream");
import { EventEmitter } from "node:events";
import { AsyncResource } from "node:async_hooks";
import {
    ConcurrentNestedTransactionError,
    IsolationLevel,
    DEFAULT_DATASOURCE,
    InvalidIsolationLevelError,
    getTransactionManager,
    PlatformTransactionManager,
    Propagation,
    transactional,
    TransactionContextMixingError,
    TransactionTimeoutError,
    UnexpectedRollbackError,
    useTransactionManager,
    afterCommit as registerAfterCommit,
    afterRollback as registerAfterRollback,
} from "@tranjs/core";
import { ctx, PostgreSQLTransactionManager, TransactionAbortedError, usePostgreSQLTransactionManager } from "../src";

const url = process.env.PG_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const table = "tranjs_pg_driver_test";
const failure = new Error("application failure");

class OtherDriverManager extends PlatformTransactionManager<object> {
    constructor() { super(); }
    protected async beginTransaction() {
        return { metadata: { driverName: Symbol("other") }, transaction: {} };
    }
    protected async commitTransaction() {}
    protected async rollbackTransaction() {}
}

describe("PostgreSQL driver (real database)", () => {
    const pool = new Pool({ connectionString: url, max: 4 });
    const secondPool = new Pool({ connectionString: url, max: 2 });
    const second = Symbol("second-pg");

    beforeAll(async () => {
        await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (id integer UNIQUE DEFERRABLE INITIALLY DEFERRED)`);
    });
    beforeEach(async () => {
        await pool.query(`DELETE FROM ${table}`);
        usePostgreSQLTransactionManager(pool);
        usePostgreSQLTransactionManager(secondPool, second);
    });
    afterEach(() => {
        expect(pool.idleCount).toBe(pool.totalCount);
        expect(secondPool.idleCount).toBe(secondPool.totalCount);
    });
    afterAll(async () => {
        await pool.query(`DROP TABLE IF EXISTS ${table}`);
        await Promise.all([pool.end(), secondPool.end()]);
        useTransactionManager(undefined as any);
    });

    async function ids() {
        return (await pool.query(`SELECT id FROM ${table} ORDER BY id`)).rows.map(row => row.id);
    }

    it("reports a COMMIT that PostgreSQL turned into ROLLBACK after a caught statement error", async () => {
        const afterCommit = jest.fn();
        const afterRollback = jest.fn();
        await expect(transactional(async () => {
            registerAfterCommit(afterCommit);
            registerAfterRollback(afterRollback);
            await ctx().query(`INSERT INTO ${table} VALUES (1)`);
            try { await ctx().query("SELECT 1 / 0"); } catch { /* caught by application code */ }
            return "service returned normally";
        })()).rejects.toBeInstanceOf(TransactionAbortedError);
        expect(await ids()).toEqual([]);
        expect(afterCommit).not.toHaveBeenCalled();
        expect(afterRollback).toHaveBeenCalledTimes(1);
    });

    it("commits normally after a NESTED step failed and rolled back to its savepoint", async () => {
        await transactional(async () => {
            await ctx().query(`INSERT INTO ${table} VALUES (1)`);
            await transactional(async () => { await ctx().query("SELECT 1 / 0"); }, { propagation: Propagation.NESTED })().catch(() => {});
        })();
        expect(await ids()).toEqual([1]);
    });

    it("rejects the owner COMMIT after a joined REQUIRED scope catches a SQL error", async () => {
        const afterCommit = jest.fn();
        const afterRollback = jest.fn();
        const result = transactional(async () => {
            registerAfterCommit(afterCommit);
            registerAfterRollback(afterRollback);
            const outer = ctx();
            await outer.query(`INSERT INTO ${table} VALUES (1)`);
            await expect(transactional(async () => {
                expect(ctx()).toBe(outer);
                await ctx().query(`INSERT INTO ${table} VALUES (2)`);
                await expect(ctx().query("SELECT 1 / 0")).rejects.toMatchObject({ code: "22012" });
                return "joined scope returned normally";
            }, { propagation: Propagation.REQUIRED })()).resolves.toBe("joined scope returned normally");
            expect(afterRollback).not.toHaveBeenCalled();
            return "owner returned normally";
        })();
        await expect(result).rejects.toBeInstanceOf(TransactionAbortedError);
        await expect(result).rejects.not.toBeInstanceOf(UnexpectedRollbackError);
        expect(afterCommit).not.toHaveBeenCalled();
        expect(afterRollback).toHaveBeenCalledTimes(1);
        expect(await ids()).toEqual([]);
        await transactional(async () => { await ctx().query(`INSERT INTO ${table} VALUES (3)`); })();
        expect(await ids()).toEqual([3]);
    });

    it("rejects an aborted REQUIRES_NEW COMMIT without affecting the outer transaction", async () => {
        const innerAfterCommit = jest.fn();
        const innerAfterRollback = jest.fn();
        const outerAfterCommit = jest.fn();
        const outerAfterRollback = jest.fn();
        await transactional(async () => {
            registerAfterCommit(outerAfterCommit);
            registerAfterRollback(outerAfterRollback);
            const outer = ctx();
            await outer.query(`INSERT INTO ${table} VALUES (1)`);
            const inner = transactional(async () => {
                expect(ctx()).not.toBe(outer);
                registerAfterCommit(innerAfterCommit);
                registerAfterRollback(innerAfterRollback);
                await ctx().query(`INSERT INTO ${table} VALUES (2)`);
                await expect(ctx().query("SELECT 1 / 0")).rejects.toMatchObject({ code: "22012" });
            }, { propagation: Propagation.REQUIRES_NEW })();
            await expect(inner).rejects.toBeInstanceOf(TransactionAbortedError);
            await expect(inner).rejects.not.toBeInstanceOf(UnexpectedRollbackError);
            expect(innerAfterCommit).not.toHaveBeenCalled();
            expect(innerAfterRollback).toHaveBeenCalledTimes(1);
            expect(ctx()).toBe(outer);
            await ctx().query(`INSERT INTO ${table} VALUES (3)`);
        })();
        expect(outerAfterCommit).toHaveBeenCalledTimes(1);
        expect(outerAfterRollback).not.toHaveBeenCalled();
        expect(await ids()).toEqual([1, 3]);
        await transactional(async () => { await ctx().query(`INSERT INTO ${table} VALUES (4)`); })();
        expect(await ids()).toEqual([1, 3, 4]);
    });

    it("commits and releases its connection", async () => {
        const result = await transactional(async () => {
            await ctx().query(`INSERT INTO ${table} VALUES (1)`);
            return 42;
        })();
        expect(result).toBe(42);
        expect(await ids()).toEqual([1]);
    });

    it("rolls back and preserves the application error", async () => {
        await expect(transactional(async () => {
            await ctx().query(`INSERT INTO ${table} VALUES (1)`);
            throw failure;
        })()).rejects.toBe(failure);
        expect(await ids()).toEqual([]);
    });

    it("REQUIRES_NEW uses a separate connection and survives outer rollback", async () => {
        await expect(transactional(async () => {
            const outer = ctx();
            await outer.query(`INSERT INTO ${table} VALUES (1)`);
            await transactional(async () => {
                expect(ctx()).not.toBe(outer);
                expect((await ctx().query(`SELECT id FROM ${table}`)).rows).toEqual([]);
                await ctx().query(`INSERT INTO ${table} VALUES (2)`);
            }, { propagation: Propagation.REQUIRES_NEW })();
            expect(ctx()).toBe(outer);
            throw failure;
        })()).rejects.toBe(failure);
        expect(await ids()).toEqual([2]);
    });

    it("NESTED rolls back to a savepoint without losing the outer transaction", async () => {
        await transactional(async () => {
            const outer = ctx();
            await outer.query(`INSERT INTO ${table} VALUES (1)`);
            await expect(transactional(async () => {
                expect(ctx()).toBe(outer);
                await ctx().query(`INSERT INTO ${table} VALUES (2)`);
                throw failure;
            }, { propagation: Propagation.NESTED })()).rejects.toBe(failure);
            await transactional(async () => {
                await ctx().query(`INSERT INTO ${table} VALUES (3)`);
            }, { propagation: Propagation.NESTED })();
        })();
        expect(await ids()).toEqual([1, 3]);
    });

    it("rejects a NESTED scope from the retained context of an ended sibling while another sibling is open", async () => {
        const nested = { propagation: Propagation.NESTED };
        const events: string[] = [];
        const callbackC = jest.fn();
        await transactional(async () => {
            await ctx().query(`INSERT INTO ${table} VALUES (1)`);
            // 1. A finishes; its async context is kept.
            let fromA!: <T>(fn: () => T) => T;
            await transactional(async () => {
                await ctx().query(`INSERT INTO ${table} VALUES (2)`);
                fromA = AsyncResource.bind(<T>(fn: () => T): T => fn());
            }, nested)();
            // 2. B is open under the owner.
            let closeB!: () => void;
            const holdB = new Promise<void>(resolve => { closeB = resolve; });
            let enteredB!: () => void;
            const inB = new Promise<void>(resolve => { enteredB = resolve; });
            const b = transactional(async () => {
                await ctx().query(`INSERT INTO ${table} VALUES (3)`);
                enteredB();
                await holdB;
                throw failure;
            }, nested)();
            await inB;
            // 3. C from A's context would open a savepoint inside B's and be undone with it.
            await expect(fromA(() => transactional(async () => {
                callbackC();
                await ctx().query(`INSERT INTO ${table} VALUES (4)`);
                registerAfterCommit(() => { events.push("C commit hook"); });
            }, nested)())).rejects.toBeInstanceOf(ConcurrentNestedTransactionError);
            // Detached work can still start an independent transaction on its own connection.
            await fromA(() => transactional(async () => {
                await ctx().query(`INSERT INTO ${table} VALUES (5)`);
            }, { propagation: Propagation.REQUIRES_NEW })());
            // 4. B rolls back to its savepoint; the owner continues.
            closeB();
            await expect(b).rejects.toBe(failure);
            // With no sibling open, the retained context nests again and its work and hook are kept.
            await fromA(() => transactional(async () => {
                await ctx().query(`INSERT INTO ${table} VALUES (6)`);
                registerAfterCommit(() => { events.push("sequential commit hook"); });
            }, nested)());
            expect((await ctx().query(`SELECT id FROM ${table} ORDER BY id`)).rows.map(row => row.id)).toEqual([1, 2, 5, 6]);
        })();
        expect(callbackC).not.toHaveBeenCalled();
        expect(events).toEqual(["sequential commit hook"]);
        expect(await ids()).toEqual([1, 2, 5, 6]);
    });

    it("rejects a NESTED scope from the retained context of an ended scope whose own child is still open", async () => {
        const nested = { propagation: Propagation.NESTED };
        const callbackD = jest.fn();
        let childResult!: PromiseSettledResult<unknown>;
        await expect(transactional(async () => {
            await ctx().query(`INSERT INTO ${table} VALUES (1)`);
            let fromE!: <T>(fn: () => T) => T;
            let closeC!: () => void;
            const holdC = new Promise<void>(resolve => { closeC = resolve; });
            let c!: Promise<unknown>;
            // E starts child C without awaiting it, then ends.
            await transactional(async () => {
                fromE = AsyncResource.bind(<T>(fn: () => T): T => fn());
                await ctx().query(`INSERT INTO ${table} VALUES (2)`);
                let enteredC!: () => void;
                const inC = new Promise<void>(resolve => { enteredC = resolve; });
                c = transactional(async () => {
                    await ctx().query(`INSERT INTO ${table} VALUES (3)`);
                    enteredC();
                    await holdC;
                }, nested)();
                await inC;
            }, nested)();
            // D from E's retained context must not open a savepoint next to the open C.
            await expect(fromE(() => transactional(async () => {
                callbackD();
                await ctx().query(`INSERT INTO ${table} VALUES (4)`);
            }, nested)())).rejects.toBeInstanceOf(ConcurrentNestedTransactionError);
            expect((await ctx().query(`SELECT id FROM ${table} ORDER BY id`)).rows.map(row => row.id)).toEqual([1, 2, 3]);
            closeC();
            [childResult] = await Promise.allSettled([c]);
            throw failure;
        })()).rejects.toBe(failure);
        expect(callbackD).not.toHaveBeenCalled();
        // Releasing E's savepoint already removed C's, which is what the missing await costs the caller.
        expect(childResult).toMatchObject({ status: "rejected", reason: { code: "3B001" } });
        expect(await ids()).toEqual([]);
    });

    it("applies the requested isolation level", async () => {
        await transactional(async () => {
            const result = await ctx().query("SHOW transaction_isolation");
            expect(result.rows[0].transaction_isolation).toBe("serializable");
        }, { isolationLevel: IsolationLevel.SERIALIZABLE })();
    });

    it("rejects writes in read-only transactions", async () => {
        await expect(transactional(async () => {
            await ctx().query(`INSERT INTO ${table} VALUES (1)`);
        }, { readOnly: true })()).rejects.toMatchObject({ code: "25006" });
        expect(await ids()).toEqual([]);
    });

    it("rejects a read-only COMMIT after the callback catches a rejected write", async () => {
        const afterCommit = jest.fn();
        const afterRollback = jest.fn();
        const result = transactional(async () => {
            registerAfterCommit(afterCommit);
            registerAfterRollback(afterRollback);
            expect((await ctx().query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on");
            await expect(ctx().query(`INSERT INTO ${table} VALUES (1)`)).rejects.toMatchObject({ code: "25006" });
            return "service returned normally";
        }, { readOnly: true })();
        await expect(result).rejects.toBeInstanceOf(TransactionAbortedError);
        await expect(result).rejects.not.toBeInstanceOf(UnexpectedRollbackError);
        expect(afterCommit).not.toHaveBeenCalled();
        expect(afterRollback).toHaveBeenCalledTimes(1);
        expect(await ids()).toEqual([]);
        await transactional(async () => { await ctx().query(`INSERT INTO ${table} VALUES (2)`); })();
        expect(await ids()).toEqual([2]);
    });

    it.each(["string", "config", "callback"])("times out a slow %s query and rolls back", async format => {
        await expect(transactional(async () => {
            await ctx().query(`INSERT INTO ${table} VALUES (1)`);
            if (format === "string") await ctx().query("SELECT pg_sleep($1)", [0.2]);
            else if (format === "config") await ctx().query({ text: "SELECT pg_sleep($1)", values: [0.2] });
            else await new Promise((resolve, reject) => {
                ctx().query("SELECT pg_sleep($1)", [0.2], (error, result) => error ? reject(error) : resolve(result));
            });
        }, { timeout: 50 })()).rejects.toThrow(TransactionTimeoutError);
        expect(await ids()).toEqual([]);
        expect((await pool.query("SHOW statement_timeout")).rows[0].statement_timeout).toBe("0");
    });

    it("passes decreasing remaining time in query configs without mutating user options", async () => {
        await transactional(async () => {
            const connection = getTransactionManager().getCurrentTransaction() as NativeClient;
            const query = jest.spyOn(connection, "query");
            const config = { text: "SELECT $1::integer AS value", values: [42], query_timeout: 5000 };
            try {
                expect((await ctx().query(config)).rows[0].value).toBe(42);
                await new Promise(resolve => setTimeout(resolve, 15));
                await ctx().query("SELECT 1");
                const first = (query.mock.calls[0][0] as any).query_timeout;
                const second = (query.mock.calls[1][0] as any).query_timeout;
                expect(first).toBeGreaterThan(second);
                expect(first).toBeLessThanOrEqual(1000);
                expect(config.query_timeout).toBe(5000);
                const shorter = { ...config, query_timeout: 200 };
                await ctx().query(shorter);
                expect((query.mock.calls[2][0] as any).query_timeout).toBeGreaterThan(200);
                expect((query.mock.calls[2][0] as any).query_timeout).toBeLessThanOrEqual(second);
                expect(shorter.query_timeout).toBe(200);
                const escape = ctx().escapeIdentifier;
                expect(escape('a"b')).toBe('"a""b"');
            } finally { query.mockRestore(); }
        }, { timeout: 1000 })();
    });

    it("passes query options and callbacks through untouched without a deadline", async () => {
        await transactional(async () => {
            const connection = getTransactionManager().getCurrentTransaction() as NativeClient;
            const query = jest.spyOn(connection, "query");
            const config = { text: "SELECT 42 AS value", query_timeout: 200 };
            try {
                await ctx().query(config);
                expect(query.mock.calls[0][0]).toBe(config);
                await new Promise<void>((resolve, reject) => {
                    const callback = (error: Error | null) => error ? reject(error) : resolve();
                    ctx().query(config, callback);
                    expect(query.mock.calls[1][0]).toBe(config);
                    expect(query.mock.calls[1][1]).toBe(callback);
                });
                expect(config.query_timeout).toBe(200);
            } finally { query.mockRestore(); }
        })();
    });

    it.each(["promise", "callback", "config callback"])(
        "translates an early driver timer in %s queries, but preserves network errors after the deadline", async format => {
            const now = Date.now();
            const clock = jest.spyOn(Date, "now").mockReturnValue(now);
            try {
                for (const timer of [true, false]) {
                    clock.mockReturnValue(now);
                    const error = timer ? new Error("Query read timeout")
                        : Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
                    await expect(transactional(async () => {
                        const connection = getTransactionManager().getCurrentTransaction() as NativeClient;
                        const query = jest.spyOn(connection, "query").mockImplementationOnce(((...args: any[]) => {
                            if (!timer) clock.mockReturnValue(now + 1001);
                            const callback = typeof args[args.length - 1] === "function"
                                ? args[args.length - 1] : args[0].callback;
                            if (callback) { callback(error); return; }
                            return Promise.reject(error);
                        }) as any);
                        try {
                            const result = format === "promise" ? ctx().query("SELECT 1")
                                : new Promise((resolve, reject) => {
                                    const callback = (error: Error | null, result: unknown) => error ? reject(error) : resolve(result);
                                    if (format === "callback") ctx().query("SELECT 1", callback);
                                    else ctx().query({ text: "SELECT 1", callback } as any);
                                });
                            if (timer) {
                                await expect(result).rejects.toThrow(TransactionTimeoutError);
                                expect(Date.now()).toBe(now); // Timer fired before the wall-clock deadline.
                            } else await expect(result).rejects.toBe(error);
                        } finally { query.mockRestore(); }
                    }, { timeout: 1000 })()).rejects.toThrow(timer ? UnexpectedRollbackError : TransactionTimeoutError);
                }
            } finally { clock.mockRestore(); }
        },
    );

    it("consumes a QueryStream inside the callback with a deadline and no lingering read timer", async () => {
        const streamPool = new Pool({ connectionString: url, max: 1, idleTimeoutMillis: 0 });
        usePostgreSQLTransactionManager(streamPool);
        try {
            await transactional(async () => {
                const connection = getTransactionManager().getCurrentTransaction() as NativeClient;
                const query = jest.spyOn(connection, "query");
                const timers = jest.spyOn(global, "setTimeout");
                const stream = new QueryStream("SELECT generate_series(1, 3) AS value");
                const submit = jest.spyOn(stream, "submit");
                try {
                    expect(ctx().query(stream)).toBe(stream);
                    const rows = [];
                    for await (const row of stream) rows.push(row);
                    expect(rows).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
                    expect(query.mock.calls[0][0]).toBe(stream);
                    expect(submit).toHaveBeenCalledTimes(1);
                    expect(timers).not.toHaveBeenCalled();
                } finally {
                    timers.mockRestore();
                    query.mockRestore();
                    submit.mockRestore();
                    stream.destroy();
                }
            }, { timeout: 10000 })();
        } finally {
            await streamPool.end();
            usePostgreSQLTransactionManager(pool);
        }
    });

    it.each(["QueryStream", "Query"])("preserves %s SQL errors delivered by error events", async format => {
        await expect(transactional(async () => {
            const submittable = format === "QueryStream" ? new QueryStream("SELECT FROM") : new Query("SELECT FROM");
            await new Promise<void>((resolve, reject) => {
                (submittable as EventEmitter).once("error", reject);
                (submittable as EventEmitter).once("end", resolve);
                if (submittable instanceof QueryStream) submittable.resume();
                expect(ctx().query(submittable)).toBe(submittable);
            });
        }, { timeout: 1000 })()).rejects.toMatchObject({ code: "42601" });
    });

    it.each(["QueryStream", "Query", "custom"])(
        "synchronously rejects an expired %s before native query or submit dispatch", async format => {
            await expect(transactional(async () => {
                const connection = getTransactionManager().getCurrentTransaction() as NativeClient;
                const submittable = format === "QueryStream" ? new QueryStream("SELECT 1")
                    : format === "Query" ? new Query("SELECT 1") : { submit: jest.fn() };
                const submit = jest.spyOn(submittable, "submit");
                const query = jest.spyOn(connection, "query");
                const clock = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
                try {
                    expect(() => ctx().query(submittable)).toThrow(TransactionTimeoutError);
                    expect(query).not.toHaveBeenCalled();
                    expect(submit).not.toHaveBeenCalled();
                } finally {
                    clock.mockRestore(); // Expiration still marks the owner rollback-only after the clock is restored.
                    query.mockRestore();
                    submit.mockRestore();
                    if (submittable instanceof QueryStream) submittable.destroy();
                }
            }, { timeout: 1000 })()).rejects.toThrow(UnexpectedRollbackError);
        },
    );

    it("cleans up a real deferred-constraint COMMIT failure exactly once", async () => {
        let release: jest.SpyInstance | undefined;
        await expect(transactional(async () => {
            release = jest.spyOn(getTransactionManager().getCurrentTransaction() as NativeClient, "release");
            await ctx().query(`INSERT INTO ${table} VALUES (1), (1)`);
        })()).rejects.toMatchObject({ code: "23505" });
        expect(release).toHaveBeenCalledTimes(1);
        release?.mockRestore();
        expect(await ids()).toEqual([]);
        await transactional(async () => { await ctx().query("SELECT 1"); })();
    });

    it("rejects injected isolation SQL before acquiring a connection without affecting data", async () => {
        await pool.query(`INSERT INTO ${table} VALUES (1)`);
        const connect = jest.spyOn(pool, "connect");
        try {
            await expect(transactional(async () => {
                await ctx().query(`DELETE FROM ${table}`);
            }, { isolationLevel: "READ COMMITTED; COMMIT; SELECT 1 --" as IsolationLevel })())
                .rejects.toThrow(InvalidIsolationLevelError);
            // Direct driver use also validates before acquiring a connection.
            await expect((new PostgreSQLTransactionManager(pool) as any).beginTransaction({
                isolationLevel: "READ COMMITTED; COMMIT; SELECT 1 --",
            })).rejects.toThrow(InvalidIsolationLevelError);
            expect(connect).not.toHaveBeenCalled();
        } finally { connect.mockRestore(); }
        expect(await ids()).toEqual([1]);
    });

    it.each(["rollback", "commit cleanup", "begin cleanup"])(
        "disposes a dirty connection exactly once after %s failure", async path => {
            const connection = await pool.connect();
            const oldPid = (await connection.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
            const query = connection.query.bind(connection);
            const rollbackError = new Error("injected ROLLBACK failure");
            const primaryError = new Error(`injected ${path} failure`);
            const release = jest.spyOn(connection, "release");
            const querySpy = jest.spyOn(connection, "query").mockImplementation((async (sql: string) => {
                if (sql === "ROLLBACK") throw rollbackError;
                if (path === "commit cleanup" && sql === "COMMIT") throw primaryError;
                const result = await query(sql);
                if (path === "begin cleanup" && sql === "BEGIN") {
                    await query(`INSERT INTO ${table} VALUES (1)`);
                    throw primaryError;
                }
                return result;
            }) as any);
            const connect = jest.spyOn(pool, "connect").mockResolvedValueOnce(connection as never);
            const log = jest.spyOn(console, "error").mockImplementation(() => {});
            try {
                const result = transactional(async () => {
                    await ctx().query(`INSERT INTO ${table} VALUES (1)`);
                    if (path === "rollback") throw primaryError;
                })();
                if (path === "rollback") await expect(result).rejects.toMatchObject({
                    name: "TransactionSystemError", cause: rollbackError, applicationError: primaryError,
                });
                else await expect(result).rejects.toBe(primaryError);
                expect(release).toHaveBeenCalledTimes(1);
                expect(release).toHaveBeenCalledWith(expect.any(Error));
                if (path === "commit cleanup") {
                    expect(querySpy.mock.calls.filter(([sql]) => sql === "ROLLBACK")).toHaveLength(0);
                }
            } finally {
                connect.mockRestore();
                querySpy.mockRestore();
                release.mockRestore();
                log.mockRestore();
            }
            await transactional(async () => {
                expect((await ctx().query("SELECT pg_backend_pid() AS pid")).rows[0].pid).not.toBe(oldPid);
                expect((await ctx().query(`SELECT id FROM ${table}`)).rows).toEqual([]);
                await ctx().query(`INSERT INTO ${table} VALUES (2)`);
            })();
            expect(await ids()).toEqual([2]);
        },
    );

    it("rejects invalid timeout configuration before BEGIN", async () => {
        await expect(transactional(async () => {}, { timeout: NaN })()).rejects.toThrow(RangeError);
        await transactional(async () => { await ctx().query("SELECT 1"); })();
    });

    it("keeps two named datasources independent", async () => {
        await expect(transactional(async () => {
            const outer = ctx();
            await outer.query(`INSERT INTO ${table} VALUES (1)`);
            expect(() => ctx(second)).toThrow("Transaction context not initialized");
            await transactional(async () => {
                expect(ctx(DEFAULT_DATASOURCE)).toBe(outer);
                expect(ctx()).toBe(ctx(second));
                expect(ctx(second)).not.toBe(outer);
                await ctx(second).query(`INSERT INTO ${table} VALUES (2)`);
            }, { datasource: second })();
            throw failure;
        })()).rejects.toBe(failure);
        expect(await ids()).toEqual([2]);
    });

    it.each([false, true])("omitted named-datasource hooks run only after physical SQL completion (rollback: %s)", async rollback => {
        const events: string[] = [];
        const observedRows: number[][] = [];
        const committed = jest.fn(async () => {
            events.push("commit hook");
            observedRows.push(await ids());
        });
        const rolledBack = jest.fn(async () => {
            events.push("rollback hook");
            observedRows.push(await ids());
        });
        let querySpy: jest.SpyInstance | undefined;
        try {
            const operation = transactional(async () => {
                const connection = getTransactionManager(second).getCurrentTransaction() as NativeClient;
                const query = connection.query;
                querySpy = jest.spyOn(connection, "query").mockImplementation(((...args: any[]) => {
                    const result = Reflect.apply(query, connection, args);
                    if (args[0] === "COMMIT" || args[0] === "ROLLBACK") {
                        return Promise.resolve(result).then(completed => {
                            events.push(`SQL ${completed.command}`);
                            return completed;
                        });
                    }
                    return result;
                }) as any);
                registerAfterCommit(committed);
                registerAfterRollback(rolledBack);
                await ctx(second).query(`INSERT INTO ${table} VALUES (1)`);
                expect(await ids()).toEqual([]);
                expect(committed).not.toHaveBeenCalled();
                expect(rolledBack).not.toHaveBeenCalled();
                if (rollback) throw failure;
            }, { datasource: second })();
            if (rollback) await expect(operation).rejects.toBe(failure);
            else await operation;
            expect(events).toEqual(rollback ? ["SQL ROLLBACK", "rollback hook"] : ["SQL COMMIT", "commit hook"]);
            expect(observedRows).toEqual([rollback ? [] : [1]]);
            expect(committed).toHaveBeenCalledTimes(rollback ? 0 : 1);
            expect(rolledBack).toHaveBeenCalledTimes(rollback ? 1 : 0);
            expect(await ids()).toEqual(rollback ? [] : [1]);
        } finally {
            querySpy?.mockRestore();
            await pool.query(`DELETE FROM ${table}`);
        }
    });

    it("throws the compatibility error outside a transaction", () => {
        expect(() => ctx()).toThrow("Transaction context not initialized");
    });

    it("rejects a different driver's manager", async () => {
        useTransactionManager(new OtherDriverManager());
        await transactional(async () => {
            expect(() => ctx()).toThrow(TransactionContextMixingError);
        })();
    });

    it("exports the manager for direct registration", () => {
        expect(new PostgreSQLTransactionManager(pool)).toBeInstanceOf(PlatformTransactionManager);
    });
});
