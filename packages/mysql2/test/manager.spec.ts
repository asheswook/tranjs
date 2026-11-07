import { createPool, PoolConnection as NativeConnection, RowDataPacket } from "mysql2/promise";
import {
    IsolationLevel,
    PlatformTransactionManager,
    Propagation,
    runInTransaction,
    TransactionContextMixingError,
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

    it("rolls back after COMMIT failure and releases exactly once", async () => {
        const commitError = new Error("injected COMMIT failure");
        let release: jest.SpyInstance | undefined;
        let rollback: jest.SpyInstance | undefined;
        let commit: jest.SpyInstance | undefined;
        await expect(runInTransaction(async () => {
            const connection = ctx() as NativeConnection;
            await connection.query(`INSERT INTO ${table} VALUES (1)`);
            release = jest.spyOn(connection, "release");
            rollback = jest.spyOn(connection, "rollback");
            // MySQL has no deferred constraints; fail COMMIT on a real checked-out connection.
            commit = jest.spyOn(connection, "commit").mockRejectedValueOnce(commitError);
        })).rejects.toBe(commitError);
        expect(release).toHaveBeenCalledTimes(1);
        expect(rollback).toHaveBeenCalledTimes(1);
        commit?.mockRestore();
        rollback?.mockRestore();
        release?.mockRestore();
        expect(await ids()).toEqual([]);
        await runInTransaction(async () => { await ctx().query("SELECT 1"); });
    });

    it("releases a connection after BEGIN configuration fails", async () => {
        await expect(runInTransaction(async () => {}, {
            isolationLevel: "INVALID" as IsolationLevel,
        })).rejects.toBeDefined();
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
        expect(new MySQLTransactionManager(pool)).toBeInstanceOf(PlatformTransactionManager);
    });
});
