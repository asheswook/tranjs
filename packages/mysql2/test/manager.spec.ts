import { createPool, PoolConnection as NativeConnection, RowDataPacket } from "mysql2/promise";
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
import { ctx, MySQLTransactionManager, useMySQLTransactionManager } from "../src";

const url = process.env.MYSQL_URL ?? "mysql://root:root@localhost:3306/test";
const table = "tranjs_mysql_driver_test";
const failure = new Error("application failure");

class OtherDriverManager extends PlatformTransactionManager<object> {
    constructor() { super(); }
    protected async beginTransaction() {
        return { metadata: { driverName: Symbol("other") }, transaction: {} };
    }
    protected async commitTransaction() {}
    protected async rollbackTransaction() {}
}

describe("MySQL driver (real database)", () => {
    const pool = createPool({ uri: url, connectionLimit: 4 });
    const secondPool = createPool({ uri: url, connectionLimit: 2 });
    const second = Symbol("second-mysql");

    beforeAll(async () => {
        await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (id integer PRIMARY KEY) ENGINE=InnoDB`);
        // SET TRANSACTION changes only the next transaction, not @@transaction_isolation.
        // Read the current transaction's actual level from Performance Schema instead.
        await pool.query("UPDATE performance_schema.setup_consumers SET ENABLED = 'YES' WHERE NAME = 'events_transactions_current'");
        await pool.query("UPDATE performance_schema.setup_instruments SET ENABLED = 'YES' WHERE NAME = 'transaction'");
    });
    beforeEach(async () => {
        await pool.query(`DELETE FROM ${table}`);
        useMySQLTransactionManager(pool);
        useMySQLTransactionManager(secondPool, second);
    });
    afterEach(() => {
        for (const current of [pool, secondPool]) {
            const stats = (current as unknown as {
                pool: { _allConnections: { length: number }; _freeConnections: { length: number } };
            }).pool;
            expect(stats._freeConnections.length).toBe(stats._allConnections.length);
        }
    });
    afterAll(async () => {
        await pool.query(`DROP TABLE IF EXISTS ${table}`);
        await Promise.all([pool.end(), secondPool.end()]);
        useTransactionManager(undefined as any);
    });

    async function ids() {
        const [rows] = await pool.query<RowDataPacket[]>(`SELECT id FROM ${table} ORDER BY id`);
        return rows.map(row => row.id);
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
                const [rows] = await ctx().query<RowDataPacket[]>(`SELECT id FROM ${table}`);
                expect(rows).toEqual([]);
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

    it("applies the requested isolation level to the current transaction", async () => {
        await runInTransaction(async () => {
            await ctx().query(`SELECT * FROM ${table}`);
            const [rows] = await ctx().query<RowDataPacket[]>(`
                SELECT ISOLATION_LEVEL AS isolationLevel
                FROM performance_schema.events_transactions_current
                WHERE THREAD_ID = (
                    SELECT THREAD_ID FROM performance_schema.threads
                    WHERE PROCESSLIST_ID = CONNECTION_ID()
                )
            `);
            expect(rows[0].isolationLevel).toBe("READ COMMITTED");
        }, { isolationLevel: IsolationLevel.READ_COMMITTED });
    });

    it("rejects writes in read-only transactions", async () => {
        await expect(runInTransaction(async () => {
            await ctx().query(`INSERT INTO ${table} VALUES (1)`);
        }, { readOnly: true })).rejects.toMatchObject({ code: "ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION" });
        expect(await ids()).toEqual([]);
    });

    it("destroys after COMMIT failure exactly once without attempting rollback", async () => {
        const commitError = new Error("injected COMMIT failure");
        let release: jest.SpyInstance | undefined;
        let rollback: jest.SpyInstance | undefined;
        let commit: jest.SpyInstance | undefined;
        let destroy: jest.SpyInstance | undefined;
        await expect(runInTransaction(async () => {
            const connection = getTransactionManager().getCurrentTransaction() as NativeConnection;
            await connection.query(`INSERT INTO ${table} VALUES (1)`);
            release = jest.spyOn(connection, "release");
            rollback = jest.spyOn(connection, "rollback");
            destroy = jest.spyOn(connection, "destroy");
            // MySQL has no deferred constraints; fail COMMIT on a real checked-out connection.
            commit = jest.spyOn(connection, "commit").mockRejectedValueOnce(commitError);
        })).rejects.toBe(commitError);
        expect(release).not.toHaveBeenCalled();
        expect(rollback).not.toHaveBeenCalled();
        expect(destroy).toHaveBeenCalledTimes(1);
        commit?.mockRestore();
        rollback?.mockRestore();
        release?.mockRestore();
        destroy?.mockRestore();
        expect(await ids()).toEqual([]);
        await runInTransaction(async () => { await ctx().query("SELECT 1"); });
    });

    it.each(["query string", "query options", "execute string", "execute options"])(
        "times out a slow %s and rolls back", async format => {
            await expect(runInTransaction(async () => {
                await ctx().query(`INSERT INTO ${table} VALUES (1)`);
                const sql = "SELECT SLEEP(?)";
                const options = { sql, timeout: 5000 };
                if (format === "query string") await ctx().query(sql, [0.2]);
                if (format === "query options") await ctx().query(options, [0.2]);
                if (format === "execute string") await ctx().execute(sql, [0.2]);
                if (format === "execute options") await ctx().execute(options, [0.2]);
                expect(options.timeout).toBe(5000);
            }, { timeout: 50 })).rejects.toThrow(TransactionTimeoutError);
            expect(await ids()).toEqual([]);
        },
    );

    it("merges query options without mutation and keeps methods bound", async () => {
        await runInTransaction(async () => {
            const connection = getTransactionManager().getCurrentTransaction() as NativeConnection;
            const query = jest.spyOn(connection, "query");
            const execute = jest.spyOn(connection, "execute");
            const config = { sql: "SELECT ? AS value", timeout: 5000, rowsAsArray: true };
            try {
                const [rows] = await ctx().query(config, [42]);
                expect(rows).toEqual([[42]]);
                await new Promise(resolve => setTimeout(resolve, 15));
                const [executed] = await ctx().execute(config, [43]);
                expect(executed).toEqual([[43]]);
                const first = (query.mock.calls[0][0] as any).timeout;
                const second = (execute.mock.calls[0][0] as any).timeout;
                expect(first).toBeGreaterThan(second);
                expect(first).toBeLessThanOrEqual(1000);
                expect(config.timeout).toBe(5000);
                await ctx().query({ ...config, timeout: 200 }, [44]);
                expect((query.mock.calls[1][0] as any).timeout).toBe(200);
                expect(ctx().threadId).toBe(connection.threadId);
                const ping = ctx().ping;
                await ping();
            } finally { query.mockRestore(); execute.mockRestore(); }
        }, { timeout: 1000 });
    });

    it("validates isolation before acquiring a connection, including direct driver use", async () => {
        const getConnection = jest.spyOn(pool, "getConnection");
        try {
            await expect(runInTransaction(async () => {}, {
                isolationLevel: "INVALID" as IsolationLevel,
            })).rejects.toThrow(InvalidIsolationLevelError);
            await expect((new MySQLTransactionManager(pool) as any).beginTransaction({
                isolationLevel: "INVALID",
            })).rejects.toThrow(InvalidIsolationLevelError);
            expect(getConnection).not.toHaveBeenCalled();
        } finally { getConnection.mockRestore(); }
    });

    it.each(["rollback", "commit cleanup", "begin cleanup"])(
        "destroys a dirty connection exactly once after %s failure", async path => {
            const connection = await pool.getConnection();
            const oldId = connection.threadId;
            const primaryError = new Error(`injected ${path} failure`);
            const release = jest.spyOn(connection, "release");
            const destroy = jest.spyOn(connection, "destroy");
            const rollbackError = new Error("injected ROLLBACK failure");
            const rollback = jest.spyOn(connection, "rollback").mockRejectedValueOnce(rollbackError);
            const commit = path === "commit cleanup"
                ? jest.spyOn(connection, "commit").mockRejectedValueOnce(primaryError) : undefined;
            const query = connection.query.bind(connection);
            const querySpy = path === "begin cleanup"
                ? jest.spyOn(connection, "query").mockImplementation((async (sql: string) => {
                    const result = await query(sql);
                    if (sql === "START TRANSACTION") {
                        await query(`INSERT INTO ${table} VALUES (1)`);
                        throw primaryError;
                    }
                    return result;
                }) as any) : undefined;
            const getConnection = jest.spyOn(pool, "getConnection").mockResolvedValueOnce(connection);
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
                expect(rollback).toHaveBeenCalledTimes(path === "commit cleanup" ? 0 : 1);
                expect(destroy).toHaveBeenCalledTimes(1);
                expect(release).not.toHaveBeenCalled();
            } finally {
                getConnection.mockRestore();
                querySpy?.mockRestore();
                commit?.mockRestore();
                rollback.mockRestore();
                destroy.mockRestore();
                release.mockRestore();
                log.mockRestore();
            }
            await runInTransaction(async () => {
                expect((ctx() as NativeConnection).threadId).not.toBe(oldId);
                const [rows] = await ctx().query<RowDataPacket[]>(`SELECT id FROM ${table}`);
                expect(rows).toEqual([]);
                await ctx().query(`INSERT INTO ${table} VALUES (2)`);
            });
            expect(await ids()).toEqual([2]);
        },
    );

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
        expect(new MySQLTransactionManager(pool)).toBeInstanceOf(PlatformTransactionManager);
    });
});
