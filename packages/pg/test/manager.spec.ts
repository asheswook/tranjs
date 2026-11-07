import { Pool, PoolClient as NativeClient } from "pg";
import {
    IsolationLevel,
    PlatformTransactionManager,
    Propagation,
    runInTransaction,
    TransactionContextMixingError,
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

    it("sets a transaction-local statement timeout", async () => {
        await runInTransaction(async () => {
            expect((await ctx().query("SHOW statement_timeout")).rows[0].statement_timeout).toBe("2s");
        }, { timeout: 2000 });
        expect((await pool.query("SHOW statement_timeout")).rows[0].statement_timeout).toBe("0");
    });

    it("cleans up a real deferred-constraint COMMIT failure exactly once", async () => {
        let release: jest.SpyInstance | undefined;
        await expect(runInTransaction(async () => {
            release = jest.spyOn(ctx() as NativeClient, "release");
            await ctx().query(`INSERT INTO ${table} VALUES (1), (1)`);
        })).rejects.toMatchObject({ code: "23505" });
        expect(release).toHaveBeenCalledTimes(1);
        release?.mockRestore();
        expect(await ids()).toEqual([]);
        await runInTransaction(async () => { await ctx().query("SELECT 1"); });
    });

    it("releases a connection after BEGIN fails", async () => {
        await expect(runInTransaction(async () => {}, {
            isolationLevel: "INVALID" as IsolationLevel,
        })).rejects.toBeDefined();
        await runInTransaction(async () => { await ctx().query("SELECT 1"); });
    });

    it("rolls back and releases when configuration after BEGIN fails", async () => {
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
