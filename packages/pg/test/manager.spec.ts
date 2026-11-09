import { Pool, PoolClient as NativeClient } from "pg";
import {
    IsolationLevel,
    InvalidIsolationLevelError,
    getTransactionManager,
    PlatformTransactionManager,
    Propagation,
    runInTransaction,
    TransactionContextMixingError,
    TransactionTimeoutError,
    useTransactionManager,
} from "@tranjs/core";
import { ctx, PostgreSQLTransactionManager, usePostgreSQLTransactionManager } from "../src";

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

    it("commits and releases its connection", async () => {
        const result = await runInTransaction(async () => {
            await ctx().query(`INSERT INTO ${table} VALUES (1)`);
            return 42;
        });
        expect(result).toBe(42);
        expect(await ids()).toEqual([1]);
    });

    it("rolls back and preserves the application error", async () => {
        await expect(runInTransaction(async () => {
            await ctx().query(`INSERT INTO ${table} VALUES (1)`);
            throw failure;
        })).rejects.toBe(failure);
        expect(await ids()).toEqual([]);
    });

    it("REQUIRES_NEW uses a separate connection and survives outer rollback", async () => {
        await expect(runInTransaction(async () => {
            const outer = ctx();
            await outer.query(`INSERT INTO ${table} VALUES (1)`);
            await runInTransaction(async () => {
                expect(ctx()).not.toBe(outer);
                expect((await ctx().query(`SELECT id FROM ${table}`)).rows).toEqual([]);
                await ctx().query(`INSERT INTO ${table} VALUES (2)`);
            }, { propagation: Propagation.REQUIRES_NEW });
            expect(ctx()).toBe(outer);
            throw failure;
        })).rejects.toBe(failure);
        expect(await ids()).toEqual([2]);
    });

    it("NESTED rolls back to a savepoint without losing the outer transaction", async () => {
        await runInTransaction(async () => {
            const outer = ctx();
            await outer.query(`INSERT INTO ${table} VALUES (1)`);
            await expect(runInTransaction(async () => {
                expect(ctx()).toBe(outer);
                await ctx().query(`INSERT INTO ${table} VALUES (2)`);
                throw failure;
            }, { propagation: Propagation.NESTED })).rejects.toBe(failure);
            await runInTransaction(async () => {
                await ctx().query(`INSERT INTO ${table} VALUES (3)`);
            }, { propagation: Propagation.NESTED });
        });
        expect(await ids()).toEqual([1, 3]);
    });

    it("applies the requested isolation level", async () => {
        await runInTransaction(async () => {
            const result = await ctx().query("SHOW transaction_isolation");
            expect(result.rows[0].transaction_isolation).toBe("serializable");
        }, { isolationLevel: IsolationLevel.SERIALIZABLE });
    });

    it("rejects writes in read-only transactions", async () => {
        await expect(runInTransaction(async () => {
            await ctx().query(`INSERT INTO ${table} VALUES (1)`);
        }, { readOnly: true })).rejects.toMatchObject({ code: "25006" });
        expect(await ids()).toEqual([]);
    });

    it.each(["string", "config", "callback"])("times out a slow %s query and rolls back", async format => {
        await expect(runInTransaction(async () => {
            await ctx().query(`INSERT INTO ${table} VALUES (1)`);
            if (format === "string") await ctx().query("SELECT pg_sleep($1)", [0.2]);
            else if (format === "config") await ctx().query({ text: "SELECT pg_sleep($1)", values: [0.2] });
            else await new Promise((resolve, reject) => {
                ctx().query("SELECT pg_sleep($1)", [0.2], (error, result) => error ? reject(error) : resolve(result));
            });
        }, { timeout: 50 })).rejects.toThrow(TransactionTimeoutError);
        expect(await ids()).toEqual([]);
        expect((await pool.query("SHOW statement_timeout")).rows[0].statement_timeout).toBe("0");
    });

    it("passes decreasing remaining time in query configs without mutating user options", async () => {
        await runInTransaction(async () => {
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
                expect((query.mock.calls[2][0] as any).query_timeout).toBe(200);
                const escape = ctx().escapeIdentifier;
                expect(escape('a"b')).toBe('"a""b"');
            } finally { query.mockRestore(); }
        }, { timeout: 1000 });
    });

    it("cleans up a real deferred-constraint COMMIT failure exactly once", async () => {
        let release: jest.SpyInstance | undefined;
        await expect(runInTransaction(async () => {
            release = jest.spyOn(getTransactionManager().getCurrentTransaction() as NativeClient, "release");
            await ctx().query(`INSERT INTO ${table} VALUES (1), (1)`);
        })).rejects.toMatchObject({ code: "23505" });
        expect(release).toHaveBeenCalledTimes(1);
        release?.mockRestore();
        expect(await ids()).toEqual([]);
        await runInTransaction(async () => { await ctx().query("SELECT 1"); });
    });

    it("rejects injected isolation SQL before acquiring a connection without affecting data", async () => {
        await pool.query(`INSERT INTO ${table} VALUES (1)`);
        const connect = jest.spyOn(pool, "connect");
        try {
            await expect(runInTransaction(async () => {
                await ctx().query(`DELETE FROM ${table}`);
            }, { isolationLevel: "READ COMMITTED; COMMIT; SELECT 1 --" as IsolationLevel }))
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
                const result = runInTransaction(async () => {
                    await ctx().query(`INSERT INTO ${table} VALUES (1)`);
                    if (path === "rollback") throw primaryError;
                });
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
            await runInTransaction(async () => {
                expect((await ctx().query("SELECT pg_backend_pid() AS pid")).rows[0].pid).not.toBe(oldPid);
                expect((await ctx().query(`SELECT id FROM ${table}`)).rows).toEqual([]);
                await ctx().query(`INSERT INTO ${table} VALUES (2)`);
            });
            expect(await ids()).toEqual([2]);
        },
    );

    it("rejects invalid timeout configuration before BEGIN", async () => {
        await expect(runInTransaction(async () => {}, { timeout: NaN })).rejects.toThrow(RangeError);
        await runInTransaction(async () => { await ctx().query("SELECT 1"); });
    });

    it("keeps two named datasources independent", async () => {
        await expect(runInTransaction(async () => {
            const outer = ctx();
            await outer.query(`INSERT INTO ${table} VALUES (1)`);
            expect(() => ctx(second)).toThrow("Transaction context not initialized");
            await runInTransaction(async () => {
                expect(ctx()).toBe(outer);
                expect(ctx(second)).not.toBe(outer);
                await ctx(second).query(`INSERT INTO ${table} VALUES (2)`);
            }, { datasource: second });
            throw failure;
        })).rejects.toBe(failure);
        expect(await ids()).toEqual([2]);
    });

    it("throws the compatibility error outside a transaction", () => {
        expect(() => ctx()).toThrow("Transaction context not initialized");
    });

    it("rejects a different driver's manager", async () => {
        useTransactionManager(new OtherDriverManager());
        await runInTransaction(async () => {
            expect(() => ctx()).toThrow(TransactionContextMixingError);
        });
    });

    it("exports the manager for direct registration", () => {
        expect(new PostgreSQLTransactionManager(pool)).toBeInstanceOf(PlatformTransactionManager);
    });
});
