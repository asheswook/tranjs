import postgres from "postgres";
import {
    afterCommit,
    afterRollback,
    getTransactionManager,
    InvalidIsolationLevelError,
    IsolationLevel,
    PlatformTransactionManager,
    Propagation,
    transactional,
    TransactionClosedError,
    TransactionContextMixingError,
    TransactionTimeoutError,
    UnexpectedRollbackError,
    useTransactionManager,
} from "@tranjs/core";
import {
    ctx, PostgresTransactionManager, TransactionAbortedError,
    usePostgresTransactionManager, usePostgresConnectionPerTransaction,
} from "../src";

const url = process.env.PG_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const table = "tranjs_postgres_driver_test";
const failure = new Error("application failure");
const itV4 = process.env.POSTGRES_MAJOR === "3" ? it.skip : it;

class OtherDriverManager extends PlatformTransactionManager<object> {
    constructor() { super(); }
    protected async beginTransaction() {
        return { metadata: { driverName: Symbol("other") }, transaction: {} };
    }
    protected async commitTransaction() {}
    protected async rollbackTransaction() {}
}

describe("postgres.js pool manager (real database)", () => {
    const debug = jest.fn();
    const sql = postgres(url, { max: 4, onnotice: false, debug });
    const secondSql = postgres(url, { max: 2, onnotice: false });
    const second = Symbol("second-postgres");

    beforeAll(async () => {
        await sql.unsafe(`CREATE TABLE IF NOT EXISTS ${table} (id integer UNIQUE DEFERRABLE INITIALLY DEFERRED)`);
    });
    beforeEach(async () => {
        await sql.unsafe(`DELETE FROM ${table}`);
        usePostgresTransactionManager(sql);
        usePostgresTransactionManager(secondSql, second);
    });
    afterEach(() => { jest.restoreAllMocks(); });
    afterAll(async () => {
        await sql.unsafe(`DROP TABLE IF EXISTS ${table}`);
        await Promise.all([sql.end(), secondSql.end()]);
        useTransactionManager(undefined as any);
        useTransactionManager(undefined as any, second);
    });

    async function ids() {
        return (await sql.unsafe(`SELECT id FROM ${table} ORDER BY id`)).map(row => row.id);
    }
    function raw() {
        return getTransactionManager().getCurrentTransaction() as postgres.ReservedSql;
    }

    it("validates batch part gates before unwrapping or native dispatch", () => {
        class GateManager extends PostgresTransactionManager {
            close(connection: any) { this.getConnectionGate(connection).closed = true; }
        }
        const manager = new GateManager(sql);
        const nativeQuery = () => ({ then: jest.fn(), cancel: jest.fn() });
        const part = nativeQuery();
        const untracked = nativeQuery();
        const otherPart = nativeQuery();
        const batch = jest.fn((_parts: any[]) => nativeQuery());
        const connection: any = Object.assign(jest.fn(), { unsafe: jest.fn(() => part), batch });
        const other: any = Object.assign(jest.fn(), { unsafe: jest.fn(() => otherPart) });
        const db: any = manager.wrapConnection(connection);
        const otherDb: any = manager.wrapConnection(other);
        const wrappedPart = db.unsafe("SELECT 1");
        const foreignPart = otherDb.unsafe("SELECT 2");

        db.batch([wrappedPart, untracked]);
        expect(batch).toHaveBeenCalledTimes(1);
        expect(batch.mock.calls[0][0]).toEqual([part, untracked]);
        expect(batch.mock.calls[0][0][0]).toBe(part);
        expect(batch.mock.calls[0][0][1]).toBe(untracked);
        expect(() => db.batch([foreignPart])).toThrow("Cannot batch queries from another transaction");
        manager.close(other);
        expect(() => db.batch([foreignPart])).toThrow(TransactionClosedError);
        expect(batch).toHaveBeenCalledTimes(1);
    });

    it("commits tagged and unsafe queries and releases the raw reserved connection once", async () => {
        const end = jest.spyOn(sql, "end");
        let release!: jest.SpyInstance;
        expect(await transactional(async () => {
            release = jest.spyOn(raw(), "release");
            await ctx()`INSERT INTO ${ctx()(table)} VALUES (${1})`;
            expect((await ctx().unsafe("SELECT $1::integer AS value", [42]))[0].value).toBe(42);
            return 42;
        })()).toBe(42);
        expect(release).toHaveBeenCalledTimes(1);
        expect(end).not.toHaveBeenCalled();
        expect(await ids()).toEqual([1]);
    });

    it("rolls back a callback error without replacing it and releases once", async () => {
        let release!: jest.SpyInstance;
        await expect(transactional(async () => {
            release = jest.spyOn(raw(), "release");
            await ctx().unsafe(`INSERT INTO ${table} VALUES (1)`);
            throw failure;
        })()).rejects.toBe(failure);
        expect(release).toHaveBeenCalledTimes(1);
        expect(await ids()).toEqual([]);
    });

    it("preserves committed data and releases once when afterCommit throws", async () => {
        let release!: jest.SpyInstance;
        await expect(transactional(async () => {
            release = jest.spyOn(raw(), "release");
            await ctx().unsafe(`INSERT INTO ${table} VALUES (1)`);
            afterCommit(() => { throw failure; });
        })()).rejects.toBe(failure);
        expect(release).toHaveBeenCalledTimes(1);
        expect(await ids()).toEqual([1]);
    });

    it("releases once after a real deferred-constraint COMMIT failure", async () => {
        let release!: jest.SpyInstance;
        const rolledBack = jest.fn();
        await expect(transactional(async () => {
            release = jest.spyOn(raw(), "release");
            afterRollback(rolledBack);
            await ctx().unsafe(`INSERT INTO ${table} VALUES (1), (1)`);
        })()).rejects.toMatchObject({ code: "23505" });
        expect(release).toHaveBeenCalledTimes(1);
        expect(rolledBack).toHaveBeenCalledTimes(1);
        expect(await ids()).toEqual([]);
        await transactional(async () => { await ctx()`SELECT 1`; })();
    });

    it("detects PostgreSQL's silent ROLLBACK on COMMIT after a caught duplicate-key error", async () => {
        const committed = jest.fn();
        const rolledBack = jest.fn();
        let release!: jest.SpyInstance;
        await expect(transactional(async () => {
            release = jest.spyOn(raw(), "release");
            afterCommit(committed);
            afterRollback(rolledBack);
            await ctx().unsafe("SET CONSTRAINTS ALL IMMEDIATE");
            await ctx().unsafe(`INSERT INTO ${table} VALUES (1)`);
            await expect(ctx().unsafe(`INSERT INTO ${table} VALUES (1)`)).rejects.toMatchObject({ code: "23505" });
        })()).rejects.toThrow(TransactionAbortedError);
        expect(committed).not.toHaveBeenCalled();
        expect(rolledBack).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledTimes(1);
        expect(await ids()).toEqual([]);
    });

    it("rolls back a swallowed joined failure and releases once", async () => {
        let release!: jest.SpyInstance;
        await expect(transactional(async () => {
            release = jest.spyOn(raw(), "release");
            await ctx().unsafe(`INSERT INTO ${table} VALUES (1)`);
            await expect(transactional(async () => { throw failure; })()).rejects.toBe(failure);
        })()).rejects.toThrow(UnexpectedRollbackError);
        expect(release).toHaveBeenCalledTimes(1);
        expect(await ids()).toEqual([]);
    });

    // Only postgres.js 4.x discards a dirty reservation on release; 3.x returns it unchanged.
    itV4.each(["rollback", "commit", "begin"])("releases a dirty reservation once after %s failure", async path => {
        const connection = await sql.reserve();
        const run = connection.unsafe.bind(connection);
        const rollbackError = new Error("injected ROLLBACK failure");
        const primaryError = new Error(`injected ${path} failure`);
        const release = jest.spyOn(connection, "release");
        const unsafe = jest.spyOn(connection, "unsafe").mockImplementation(((statement: string, ...args: any[]) => {
            if (statement === "ROLLBACK") return Promise.reject(rollbackError);
            if (path === "commit" && statement === "COMMIT") return Promise.reject(primaryError);
            const result = (run as any)(statement, ...args);
            if (path === "begin" && /^BEGIN\b/.test(statement)) return result.then(async () => {
                await run(`INSERT INTO ${table} VALUES (1)`);
                throw primaryError;
            });
            return result;
        }) as any);
        jest.spyOn(sql, "reserve").mockResolvedValueOnce(connection);
        getTransactionManager().setLogger({ error() {}, info() {}, warn() {}, debug() {} });
        const result = transactional(async () => {
            await ctx().unsafe(`INSERT INTO ${table} VALUES (1)`);
            if (path === "rollback") throw primaryError;
        })();
        if (path === "rollback") await expect(result).rejects.toMatchObject({
            name: "TransactionSystemError", cause: rollbackError, applicationError: primaryError,
        });
        else await expect(result).rejects.toBe(primaryError);
        expect(release).toHaveBeenCalledTimes(1);
        if (path === "commit") expect(unsafe.mock.calls.filter(([statement]) => statement === "ROLLBACK")).toHaveLength(0);
        expect(await ids()).toEqual([]);
        await transactional(async () => {
            await ctx().unsafe(`INSERT INTO ${table} VALUES (2)`);
        })();
        expect(await ids()).toEqual([2]);
    });

    it("uses savepoints for NESTED and restores an aborted savepoint", async () => {
        await transactional(async () => {
            const outer = ctx();
            await outer.unsafe("SET CONSTRAINTS ALL IMMEDIATE");
            await outer.unsafe(`INSERT INTO ${table} VALUES (1)`);
            await expect(transactional(async () => {
                expect(ctx()).toBe(outer);
                await ctx().unsafe(`INSERT INTO ${table} VALUES (1)`);
            }, { propagation: Propagation.NESTED })()).rejects.toMatchObject({ code: "23505" });
            await transactional(async () => {
                expect(ctx()).toBe(outer);
                await ctx().unsafe(`INSERT INTO ${table} VALUES (3)`);
            }, { propagation: Propagation.NESTED })();
        })();
        expect(await ids()).toEqual([1, 3]);
    });

    it("REQUIRES_NEW reserves a different backend and survives outer rollback", async () => {
        await expect(transactional(async () => {
            const outer = ctx();
            const [{ pid }] = await outer`SELECT pg_backend_pid() AS pid`;
            await outer.unsafe(`INSERT INTO ${table} VALUES (1)`);
            await transactional(async () => {
                expect(ctx()).not.toBe(outer);
                expect((await ctx()`SELECT pg_backend_pid() AS pid`)[0].pid).not.toBe(pid);
                expect(await ctx().unsafe(`SELECT id FROM ${table}`)).toHaveLength(0);
                await ctx().unsafe(`INSERT INTO ${table} VALUES (2)`);
            }, { propagation: Propagation.REQUIRES_NEW })();
            expect(ctx()).toBe(outer);
            throw failure;
        })()).rejects.toBe(failure);
        expect(await ids()).toEqual([2]);
    });

    it("applies isolation and read-only SQL before the callback", async () => {
        await transactional(async () => {
            expect((await ctx()`SELECT current_setting('transaction_isolation') AS value`)[0].value).toBe("serializable");
            expect((await ctx()`SELECT current_setting('transaction_read_only') AS value`)[0].value).toBe("on");
        }, { isolationLevel: IsolationLevel.SERIALIZABLE, readOnly: true })();
        await expect(transactional(async () => {
            await ctx().unsafe(`INSERT INTO ${table} VALUES (1)`);
        }, { readOnly: true })()).rejects.toMatchObject({ code: "25006" });
        expect(await ids()).toEqual([]);
    });

    it("hides release() and dispose methods on ctx(), so `using` can't release before commit", async () => {
        await transactional(async () => {
            const tx = ctx() as any;
            expect(tx.release).toBeUndefined();
            expect(tx[Symbol.dispose]).toBeUndefined();
            expect(tx[Symbol.asyncDispose]).toBeUndefined();
            expect("release" in tx).toBe(false);
            for (const member of ["begin", "reserve", "end", "close", "listen", "subscribe", "largeObject"]) {
                expect(tx[member]).toBeUndefined();
                expect(member in tx).toBe(false);
            }
            if (process.env.POSTGRES_MAJOR === "3") expect(tx.batch).toBeUndefined();
            await tx.unsafe(`INSERT INTO ${table} VALUES (7)`);
        })();
        expect(await ids()).toEqual([7]);
    });

    it("sends notify() through the deadline wrapper", async () => {
        const received: string[] = [];
        const listener = await sql.listen("tranjs_notify_test", value => received.push(value));
        await transactional(async () => { await ctx().notify("tranjs_notify_test", "committed"); })();
        await expect(transactional(async () => {
            await new Promise(resolve => setTimeout(resolve, 150));
            await ctx().notify("tranjs_notify_test", "after-deadline");
        }, { timeout: 100 })()).rejects.toThrow(TransactionTimeoutError);
        await new Promise(resolve => setTimeout(resolve, 200));
        await listener.unlisten();
        expect(received).toEqual(["committed"]);
    });

    it.each(["tagged", "unsafe", "execute"])("cancels an in-flight %s query, both first and after an earlier query", async format => {
        for (const armed of [false, true]) {
            await expect(transactional(async () => {
                if (armed) await ctx().unsafe(`INSERT INTO ${table} VALUES (1)`);
                const query = format === "unsafe" ? ctx().unsafe("SELECT pg_sleep($1)", [0.3]) : ctx()`SELECT pg_sleep(${0.3})`;
                if (format === "execute") await query.execute();
                else await query;
            }, { timeout: 100 })()).rejects.toThrow(TransactionTimeoutError);
            expect(await ids()).toEqual([]);
        }
        expect((await sql`SHOW statement_timeout`)[0].statement_timeout).toBe("0");
    });

    it("passes cursor, forEach and readable results through inside the callback", async () => {
        await transactional(async () => {
            const rows: number[] = [];
            for await (const batch of ctx()`SELECT generate_series(1, 3) AS value`.cursor(2)) {
                rows.push(...batch.map(row => row.value));
            }
            expect(rows).toEqual([1, 2, 3]);
            const each: number[] = [];
            await ctx()`SELECT generate_series(1, 3) AS value`.forEach(row => { each.push(row.value); });
            expect(each).toEqual([1, 2, 3]);
            const stream = await ctx().unsafe("COPY (SELECT generate_series(1, 3)) TO STDOUT").readable();
            const chunks: Buffer[] = [];
            for await (const chunk of stream) chunks.push(Buffer.from(chunk));
            expect(Buffer.concat(chunks).toString()).toBe("1\n2\n3\n");
        }, { timeout: 10000 })();
    });

    it("does not install a transaction query timer while consuming a cursor", async () => {
        await transactional(async () => {
            await ctx()`SELECT 1`; // Warm driver initialization before observing timers.
            const timers = jest.spyOn(global, "setTimeout");
            try {
                const rows: number[] = [];
                for await (const batch of ctx()`SELECT generate_series(1, 3) AS value`.cursor(1)) {
                    rows.push(batch[0].value);
                }
                expect(rows).toEqual([1, 2, 3]);
                expect(timers).not.toHaveBeenCalled();
            } finally { timers.mockRestore(); }
        }, { timeout: 10000 })();
    });

    it.each(["cursor", "forEach", "readable"] as const)("passes native %s return values and callbacks through untouched", async mode => {
        await transactional(async () => {
            const native = raw().unsafe(mode === "readable" ? "COPY (SELECT 42) TO STDOUT" : "SELECT 42 AS value");
            const unsafe = jest.spyOn(raw(), "unsafe").mockReturnValueOnce(native);
            const method = jest.spyOn(native, mode);
            try {
                const query = ctx().unsafe("ignored: returns the preconstructed native query");
                if (mode === "cursor") {
                    const callback = jest.fn();
                    const result = query.cursor(1, callback);
                    expect(result).toBe(method.mock.results[0].value);
                    expect(method).toHaveBeenCalledWith(1, callback);
                    await result;
                    expect(callback).toHaveBeenCalled();
                } else if (mode === "forEach") {
                    const callback = jest.fn();
                    const result = query.forEach(callback);
                    expect(result).toBe(method.mock.results[0].value);
                    expect(method).toHaveBeenCalledWith(callback);
                    await result;
                    expect(callback).toHaveBeenCalledTimes(1);
                } else {
                    const result = query.readable();
                    expect(result).toBe(method.mock.results[0].value);
                    const stream = await result;
                    for await (const _chunk of stream) { /* fully consume the native stream */ }
                }
            } finally {
                method.mockRestore();
                unsafe.mockRestore();
            }
        }, { timeout: 10000 })();
    });

    it("arms one timer on the first then, not at construction, and clears it on settlement", async () => {
        const now = Date.now();
        const clock = jest.spyOn(Date, "now").mockReturnValue(now);
        try {
            await transactional(async () => {
                await ctx()`SELECT 1`;
                const timers = jest.spyOn(global, "setTimeout");
                const clear = jest.spyOn(global, "clearTimeout");
                try {
                    const pending = ctx()`SELECT 42 AS value`;
                    expect(timers).not.toHaveBeenCalled();
                    clock.mockReturnValue(now + 100);
                    expect((await pending)[0].value).toBe(42);
                    expect(timers).toHaveBeenCalledTimes(1);
                    expect(timers).toHaveBeenCalledWith(expect.any(Function), 900);
                    expect(clear).toHaveBeenCalledWith(timers.mock.results[0].value);
                    await pending;
                    expect(timers).toHaveBeenCalledTimes(1);
                } finally {
                    timers.mockRestore();
                    clear.mockRestore();
                }
            }, { timeout: 1000 })();
        } finally { clock.mockRestore(); }
    });

    it("cancels the pending query and maps its rejection, rather than only timing out at commit", async () => {
        let cancel!: jest.SpyInstance;
        await expect(transactional(async () => {
            const native = raw().unsafe("SELECT pg_sleep(0.5)");
            cancel = jest.spyOn(native, "cancel");
            jest.spyOn(raw(), "unsafe").mockReturnValueOnce(native);
            await expect(ctx().unsafe("ignored")).rejects.toThrow(TransactionTimeoutError);
            expect(cancel).toHaveBeenCalledTimes(1);
        }, { timeout: 100 })()).rejects.toThrow(TransactionTimeoutError);
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    it("lets a cursor finish after the deadline without cancellation, then rolls back at completion", async () => {
        let consumed = false;
        let cancel!: jest.SpyInstance;
        await expect(transactional(async () => {
            const native = raw().unsafe("SELECT 42 AS value, pg_sleep(0.2)");
            cancel = jest.spyOn(native, "cancel");
            jest.spyOn(raw(), "unsafe").mockReturnValueOnce(native);
            const values: number[] = [];
            for await (const rows of ctx().unsafe("ignored").cursor(1)) values.push(...rows.map(row => row.value));
            expect(values).toEqual([42]);
            consumed = true;
        }, { timeout: 100 })()).rejects.toThrow(TransactionTimeoutError);
        expect(consumed).toBe(true);
        expect(cancel).not.toHaveBeenCalled();
    });

    it("preserves a user cancellation's 57014 instead of translating it to a deadline error", async () => {
        await expect(transactional(async () => {
            const query = ctx()`SELECT pg_sleep(0.5)`.execute();
            await new Promise(resolve => setTimeout(resolve, 30));
            await query.cancel();
            await expect(query).rejects.toMatchObject({ code: "57014" });
        }, { timeout: 1000 })()).rejects.toThrow(TransactionAbortedError);
    });

    itV4("preserves postgres.js instance query_timeout options and errors", async () => {
        const options = { max: 1, onnotice: false as const, query_timeout: 0.05 };
        const timed = postgres(url, options);
        usePostgresTransactionManager(timed);
        try {
            await expect(transactional(async () => {
                await ctx()`SELECT pg_sleep(0.3)`;
            }, { timeout: 1000 })()).rejects.toMatchObject({ code: "QUERY_TIMEOUT", cause: { code: "57014" } });
            expect(options.query_timeout).toBe(0.05);
            expect(timed.options.query_timeout).toBe(0.05);
        } finally { await timed.end(); }
    });

    it("passes the native deprecated stream error through unchanged", async () => {
        await transactional(async () => {
            const native = raw().unsafe("SELECT 1");
            const stream = jest.spyOn(native, "stream");
            jest.spyOn(raw(), "unsafe").mockReturnValueOnce(native);
            expect(() => ctx().unsafe("ignored").stream(() => {})).toThrow(".stream has been renamed to .forEach");
            expect(stream).toHaveBeenCalledTimes(1);
        }, { timeout: 1000 })();
    });

    it.each(["pool", "connection"])("keeps guarded SQL helpers as own reserved-function properties in %s mode", async mode => {
        if (mode === "connection") usePostgresConnectionPerTransaction(url);
        await transactional(async () => {
            const native: any = raw();
            const ownHelpers = ["unsafe", "file", "notify", "json", "array", "typed", "types"];
            if (process.env.POSTGRES_MAJOR !== "3") ownHelpers.push("batch", "identifier");
            for (const name of ownHelpers) {
                expect(Object.prototype.hasOwnProperty.call(native, name)).toBe(true);
                expect(typeof native[name]).toBe("function");
            }
            if (process.env.POSTGRES_MAJOR === "3") {
                expect(native.batch).toBeUndefined();
                expect(native.identifier).toBeUndefined();
            }
            for (const name of ["bind", "valueOf", "call", "apply"]) {
                expect(Object.prototype.hasOwnProperty.call(native, name)).toBe(false);
            }
            const connection: any = ctx();
            expect(connection.valueOf()).toBe(connection);
            expect((await connection.bind(null)`SELECT 42 AS value`)[0].value).toBe(42);
        })();
    });

    it.each(["pool", "connection"])("preserves custom typed helpers and the types alias in %s mode", async mode => {
        const types = { bigint: postgres.BigInt };
        const custom = postgres(url, { max: 1, onnotice: false, types });
        if (mode === "pool") usePostgresTransactionManager(custom);
        else {
            const parsed = new URL(url);
            usePostgresConnectionPerTransaction({
                host: parsed.hostname, port: Number(parsed.port || 5432),
                user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password),
                database: decodeURIComponent(parsed.pathname.slice(1)), types, onnotice: false,
            });
        }
        try {
            await transactional(async () => {
                const transaction = ctx<{ bigint: bigint }>();
                expect(transaction.typed).toBe(raw().typed);
                expect(transaction.types).toBe(transaction.typed);
                const value = BigInt("9007199254740993");
                const [row] = await transaction`SELECT ${transaction.typed.bigint(value)} AS typed,
                    ${transaction.types.bigint(value)} AS alias, ${transaction.typed(value, 20)} AS callable`;
                expect(row).toEqual({ typed: value, alias: value, callable: value });
            })();
        } finally { await custom.end(); }
    });

    itV4.each(["pool", "connection"])("runs lazy batches normally in %s mode", async mode => {
        if (mode === "connection") usePostgresConnectionPerTransaction(url);
        await transactional(async () => {
            const transaction = ctx();
            const queries = [transaction`SELECT 1 AS value`, transaction.unsafe("SELECT 2 AS value")];
            const batch = transaction.batch(queries);
            expect((await batch).map(rows => rows[0].value)).toEqual([1, 2]);
            expect(queries).toHaveLength(2);
        }, { timeout: 1000 })();
    });

    itV4.each(["pool", "connection"])("cancels a running batch at the deadline in %s mode", async mode => {
        if (mode === "connection") usePostgresConnectionPerTransaction(url);
        let cancel!: jest.SpyInstance;
        await expect(transactional(async () => {
            const nativeBatch = jest.spyOn(raw(), "batch");
            const transaction = ctx();
            const pending = transaction.batch([transaction`SELECT 1`, transaction`SELECT pg_sleep(0.5)`]);
            cancel = jest.spyOn(nativeBatch.mock.results[0].value, "cancel");
            await expect(pending).rejects.toThrow(TransactionTimeoutError);
            expect(cancel).toHaveBeenCalledTimes(1);
        }, { timeout: 100 })()).rejects.toThrow(TransactionTimeoutError);
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    itV4.each(["pool", "connection"])("rejects a lazy batch awaited after expiry before dispatch in %s mode", async mode => {
        if (mode === "connection") usePostgresConnectionPerTransaction(url);
        await expect(transactional(async () => {
            const nativeBatch = jest.spyOn(raw(), "batch");
            const transaction = ctx();
            const pending = transaction.batch([transaction`SELECT pg_sleep(0.5)`]);
            const native = nativeBatch.mock.results[0].value;
            const then = jest.spyOn(native, "then");
            const cancel = jest.spyOn(native, "cancel");
            const clock = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 20000);
            try {
                await expect((async () => await pending)()).rejects.toThrow(TransactionTimeoutError);
                expect(then).not.toHaveBeenCalled();
                expect(cancel).not.toHaveBeenCalled();
                expect(native.executed).toBe(false);
            } finally { clock.mockRestore(); }
        }, { timeout: 10000 })()).rejects.toThrow(UnexpectedRollbackError);
    });

    it.each(["tagged", "bind", "valueOf", "unsafe", "then", "execute", "cursor", "forEach", "readable"])(
        "checks an expired deadline before %s dispatch", async format => {
            await expect(transactional(async () => {
                const connection = ctx();
                const callable = format === "bind" ? (connection as any).bind(null)
                    : format === "valueOf" ? connection.valueOf() as typeof connection : connection;
                const pending = ["tagged", "bind", "valueOf", "unsafe"].includes(format) ? undefined
                    : format === "readable" ? connection.unsafe("COPY (SELECT 1) TO STDOUT") : connection`SELECT 1`;
                // Driver debug is called only for dispatched SQL, not lazy query construction.
                debug.mockClear();
                const clock = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 20000);
                try {
                    const dispatch = async () => {
                        const query = pending ?? (format === "unsafe" || format === "readable"
                            ? connection.unsafe(format === "readable" ? "COPY (SELECT 1) TO STDOUT" : "SELECT 1")
                            : callable`SELECT 1`);
                        if (format === "execute") await query.execute();
                        else if (format === "cursor") { for await (const _rows of query.cursor(1)) { /* consume */ } }
                        else if (format === "forEach") await query.forEach(() => {});
                        else if (format === "readable") await query.readable();
                        else await query;
                    };
                    await expect(dispatch()).rejects.toThrow(TransactionTimeoutError);
                    expect(debug).not.toHaveBeenCalled();
                } finally {
                    clock.mockRestore();
                }
            }, { timeout: 10000 })()).rejects.toThrow(UnexpectedRollbackError);
        },
    );

    it("validates isolation before reserving, including direct driver calls", async () => {
        const reserve = jest.spyOn(sql, "reserve");
        const invalid = "READ COMMITTED; COMMIT; SELECT 1 --";
        await expect(transactional(async () => {}, { isolationLevel: invalid as IsolationLevel })())
            .rejects.toThrow(InvalidIsolationLevelError);
        await expect((new PostgresTransactionManager(sql) as any).beginTransaction({ isolationLevel: invalid }))
            .rejects.toThrow(InvalidIsolationLevelError);
        expect(reserve).not.toHaveBeenCalled();
    });

    it("keeps named datasource contexts independent", async () => {
        await expect(transactional(async () => {
            const outer = ctx();
            await outer.unsafe(`INSERT INTO ${table} VALUES (1)`);
            expect(() => ctx(second)).toThrow("Transaction context not initialized");
            await transactional(async () => {
                expect(ctx()).toBe(outer);
                expect(ctx(second)).not.toBe(outer);
                await ctx(second).unsafe(`INSERT INTO ${table} VALUES (2)`);
            }, { datasource: second })();
            throw failure;
        })()).rejects.toBe(failure);
        expect(await ids()).toEqual([2]);
    });

    it("rejects foreign contexts and keeps the compatibility error outside a transaction", async () => {
        expect(() => ctx()).toThrow("Transaction context not initialized");
        useTransactionManager(new OtherDriverManager());
        await transactional(async () => { expect(() => ctx()).toThrow(TransactionContextMixingError); })();
        expect(new PostgresTransactionManager(sql)).toBeInstanceOf(PlatformTransactionManager);
    });

    it("documents the per-request registration hazard", async () => {
        let started!: () => void;
        const firstStarted = new Promise<void>(resolve => { started = resolve; });
        let resume!: () => void;
        const secondFinished = new Promise<void>(resolve => { resume = resolve; });
        const first = transactional(async () => {
            await ctx()`SELECT 1`;
            started();
            await secondFinished;
            await ctx()`SELECT 2`;
        })();
        await firstStarted;
        usePostgresTransactionManager(sql);
        const secondCall = transactional(async () => { await ctx()`SELECT 3`; })().finally(resume);
        const results = await Promise.allSettled([first, secondCall]);
        expect(results[0]).toMatchObject({ status: "rejected", reason: new Error("Transaction context not initialized") });
        expect(results[1].status).toBe("fulfilled");
    });
});
