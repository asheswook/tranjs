import { Client, ClientConfig, Pool, Query } from "pg";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
    afterCommit,
    DEFAULT_DATASOURCE,
    getTransactionManager,
    InvalidIsolationLevelError,
    IsolationLevel,
    PlatformTransactionManager,
    Propagation,
    transactional,
    TransactionTimeoutError,
    UnexpectedRollbackError,
    useTransactionManager,
    afterCommit as registerAfterCommit,
    afterRollback as registerAfterRollback,
} from "@tranjs/core";
import {
    ctx,
    PostgreSQLClientPerTransactionManager,
    usePostgreSQLClientPerTransaction,
    usePostgreSQLTransactionManager,
    TransactionAbortedError,
} from "../src";

const connectionString = process.env.PG_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const table = "tranjs_pg_client_per_transaction_test";
const failure = new Error("application failure");
const execFileAsync = promisify(execFile);

describe("PostgreSQL client per transaction (real database)", () => {
    const pool = new Pool({ connectionString, max: 2 });
    let end: jest.SpyInstance;

    beforeAll(async () => {
        await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (id integer UNIQUE DEFERRABLE INITIALLY DEFERRED)`);
    });
    beforeEach(async () => {
        await pool.query(`DELETE FROM ${table}`);
        usePostgreSQLClientPerTransaction({ connectionString });
        end = jest.spyOn(Client.prototype, "end");
    });
    afterEach(() => { jest.restoreAllMocks(); });
    afterAll(async () => {
        await pool.query(`DROP TABLE IF EXISTS ${table}`);
        await pool.end();
        useTransactionManager(undefined as any);
    });

    async function ids() {
        return (await pool.query(`SELECT id FROM ${table} ORDER BY id`)).rows.map(row => row.id);
    }
    async function pid() {
        return (await ctx().query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
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
            expect(end).not.toHaveBeenCalled();
            return "owner returned normally";
        })();
        await expect(result).rejects.toBeInstanceOf(TransactionAbortedError);
        await expect(result).rejects.not.toBeInstanceOf(UnexpectedRollbackError);
        expect(afterCommit).not.toHaveBeenCalled();
        expect(afterRollback).toHaveBeenCalledTimes(1);
        expect(end).toHaveBeenCalledTimes(1);
        expect(await ids()).toEqual([]);
        await transactional(async () => { await ctx().query(`INSERT INTO ${table} VALUES (3)`); })();
        expect(end).toHaveBeenCalledTimes(2);
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
            expect(end).toHaveBeenCalledTimes(1);
            expect(ctx()).toBe(outer);
            await ctx().query(`INSERT INTO ${table} VALUES (3)`);
        })();
        expect(outerAfterCommit).toHaveBeenCalledTimes(1);
        expect(outerAfterRollback).not.toHaveBeenCalled();
        expect(end).toHaveBeenCalledTimes(2);
        expect(await ids()).toEqual([1, 3]);
        await transactional(async () => { await ctx().query(`INSERT INTO ${table} VALUES (4)`); })();
        expect(end).toHaveBeenCalledTimes(3);
        expect(await ids()).toEqual([1, 3, 4]);
    });

    it("commits and ends the client exactly once", async () => {
        expect(await transactional(async () => {
            await ctx().query(`INSERT INTO ${table} VALUES (1)`);
            return 42;
        })()).toBe(42);
        expect(end).toHaveBeenCalledTimes(1);
        expect(await ids()).toEqual([1]);
    });

    it("rolls back a callback throw and ends the client exactly once", async () => {
        await expect(transactional(async () => {
            await ctx().query(`INSERT INTO ${table} VALUES (1)`);
            throw failure;
        })()).rejects.toBe(failure);
        expect(end).toHaveBeenCalledTimes(1);
        expect(await ids()).toEqual([]);
    });

    it("preserves committed data and ends once when afterCommit throws", async () => {
        await expect(transactional(async () => {
            await ctx().query(`INSERT INTO ${table} VALUES (1)`);
            afterCommit(() => { throw failure; });
        })()).rejects.toBe(failure);
        expect(end).toHaveBeenCalledTimes(1);
        expect(await ids()).toEqual([1]);
    });

    it("rolls back and ends once after a swallowed joined failure", async () => {
        await expect(transactional(async () => {
            await ctx().query(`INSERT INTO ${table} VALUES (1)`);
            await expect(transactional(async () => {
                await ctx().query(`INSERT INTO ${table} VALUES (2)`);
                throw failure;
            })()).rejects.toBe(failure);
        })()).rejects.toThrow(UnexpectedRollbackError);
        expect(end).toHaveBeenCalledTimes(1);
        expect(await ids()).toEqual([]);
    });

    it("ends the client exactly once after a real deferred-constraint COMMIT failure", async () => {
        await expect(transactional(async () => {
            await ctx().query(`INSERT INTO ${table} VALUES (1), (1)`);
        })()).rejects.toMatchObject({ code: "23505" });
        expect(end).toHaveBeenCalledTimes(1);
        expect(await ids()).toEqual([]);
    });

    it("ends the client exactly once after ROLLBACK failure", async () => {
        const rollbackError = new Error("injected rollback failure");
        jest.spyOn(console, "error").mockImplementation(() => {});
        await expect(transactional(async () => {
            await ctx().query(`INSERT INTO ${table} VALUES (1)`);
            const client = getTransactionManager().getCurrentTransaction() as Client;
            jest.spyOn(client, "query").mockRejectedValueOnce(rollbackError as never);
            throw failure;
        })()).rejects.toMatchObject({ name: "TransactionSystemError", cause: rollbackError, applicationError: failure });
        expect(end).toHaveBeenCalledTimes(1);
        expect(await ids()).toEqual([]);
    });

    it("ends the client exactly once after a real connect failure", async () => {
        const invalidUrl = new URL(connectionString);
        invalidUrl.password = "incorrect-password";
        usePostgreSQLClientPerTransaction({ connectionString: invalidUrl.toString() });
        await expect(transactional(async () => {})()).rejects.toMatchObject({ code: "28P01" });
        expect(end).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])("rolls back and ends exactly once after BEGIN fails (rollback failure: %s)", async rollbackFails => {
        const query = Client.prototype.query;
        const beginError = new Error("BEGIN reported failure after succeeding");
        const spy = jest.spyOn(Client.prototype, "query").mockImplementation((async function (this: Client, sql: string) {
            if (sql === "ROLLBACK" && rollbackFails) throw new Error("injected rollback failure");
            const runQuery = query.bind(this);
            const result = await runQuery(sql);
            if (sql === "BEGIN") {
                await runQuery(`INSERT INTO ${table} VALUES (1)`);
                throw beginError;
            }
            return result;
        }) as any);
        await expect(transactional(async () => { throw new Error("must not run"); })()).rejects.toBe(beginError);
        expect(spy.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "ROLLBACK"]);
        expect(end).toHaveBeenCalledTimes(1);
        spy.mockRestore();
        expect(await ids()).toEqual([]);
    });

    it.each([false, true])("logs end failures without masking the transaction outcome (callback throws: %s)", async throws => {
        const cleanupError = new Error("end reported failure");
        const originalEnd = end.getMockImplementation()!;
        end.mockImplementation(async function (this: Client) {
            await originalEnd.call(this);
            throw cleanupError;
        });
        const log = jest.fn(() => { throw new Error("logger failed too"); });
        getTransactionManager().setLogger({ error: log, info() {}, warn() {}, debug() {} });
        const result = transactional(async () => {
            await ctx().query(`INSERT INTO ${table} VALUES (1)`);
            if (throws) throw failure;
            return 42;
        })();
        if (throws) await expect(result).rejects.toBe(failure);
        else await expect(result).resolves.toBe(42);
        expect(end).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith("PostgreSQL client cleanup failed", cleanupError);
        expect(await ids()).toEqual(throws ? [] : [1]);
    });

    it("applies isolation and read-only SQL", async () => {
        // The rejected write aborts the transaction, so PostgreSQL turns COMMIT into ROLLBACK.
        await expect(transactional(async () => {
            expect((await ctx().query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("serializable");
            expect((await ctx().query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on");
            await expect(ctx().query(`INSERT INTO ${table} VALUES (1)`)).rejects.toMatchObject({ code: "25006" });
        }, { isolationLevel: IsolationLevel.SERIALIZABLE, readOnly: true })()).rejects.toBeInstanceOf(TransactionAbortedError);
        expect(end).toHaveBeenCalledTimes(1);
        expect(await ids()).toEqual([]);
    });

    it("validates isolation before resolving config or constructing a client", async () => {
        const config = jest.fn(() => ({ connectionString }));
        const manager = new PostgreSQLClientPerTransactionManager(config);
        expect(manager).toBeInstanceOf(PlatformTransactionManager);
        await expect((manager as any).beginTransaction({ isolationLevel: "READ COMMITTED; COMMIT" }))
            .rejects.toThrow(InvalidIsolationLevelError);
        useTransactionManager(manager);
        await expect(transactional(async () => {}, { isolationLevel: "invalid" as IsolationLevel })())
            .rejects.toThrow(InvalidIsolationLevelError);
        expect(config).not.toHaveBeenCalled();
        expect(end).not.toHaveBeenCalled();
    });

    it("uses savepoints for NESTED without opening or ending another Client", async () => {
        await transactional(async () => {
            const outer = ctx();
            const outerPid = await pid();
            await ctx().query(`INSERT INTO ${table} VALUES (1)`);
            await expect(transactional(async () => {
                expect(ctx()).toBe(outer);
                expect(await pid()).toBe(outerPid);
                await ctx().query(`INSERT INTO ${table} VALUES (2)`);
                throw failure;
            }, { propagation: Propagation.NESTED })()).rejects.toBe(failure);
            await transactional(async () => {
                await ctx().query(`INSERT INTO ${table} VALUES (3)`);
            }, { propagation: Propagation.NESTED })();
            expect(end).not.toHaveBeenCalled();
        })();
        expect(end).toHaveBeenCalledTimes(1);
        expect(await ids()).toEqual([1, 3]);
    });

    it("opens a second Client for REQUIRES_NEW and resumes the outer transaction", async () => {
        const connect = jest.spyOn(Client.prototype, "connect");
        await expect(transactional(async () => {
            const outer = ctx();
            const outerPid = await pid();
            await ctx().query(`INSERT INTO ${table} VALUES (1)`);
            await transactional(async () => {
                expect(ctx()).not.toBe(outer);
                expect(await pid()).not.toBe(outerPid);
                expect((await ctx().query(`SELECT id FROM ${table}`)).rows).toEqual([]);
                await ctx().query(`INSERT INTO ${table} VALUES (2)`);
            }, { propagation: Propagation.REQUIRES_NEW })();
            expect(end).toHaveBeenCalledTimes(1);
            expect(ctx()).toBe(outer);
            expect(await pid()).toBe(outerPid);
            throw failure;
        })()).rejects.toBe(failure);
        expect(connect).toHaveBeenCalledTimes(2);
        expect(end).toHaveBeenCalledTimes(2);
        expect(new Set(end.mock.contexts).size).toBe(2);
        expect(await ids()).toEqual([2]);
    });

    it.each(["promise", "callback"])("enforces the per-query deadline for %s queries", async format => {
        await expect(transactional(async () => {
            await ctx().query(`INSERT INTO ${table} VALUES (1)`);
            if (format === "promise") await ctx().query("SELECT pg_sleep(0.2)");
            else await new Promise<void>((resolve, reject) => {
                ctx().query("SELECT pg_sleep(0.2)", error => error ? reject(error) : resolve());
            });
        }, { timeout: 75 })()).rejects.toThrow(TransactionTimeoutError);
        expect(end).toHaveBeenCalledTimes(1);
        expect(await ids()).toEqual([]);
    });

    it("rejects expired deadlines before dispatch and passes Submittables through untouched", async () => {
        await expect(transactional(async () => {
            const submittable = new Query("SELECT 42 AS value");
            const client = getTransactionManager().getCurrentTransaction() as Client;
            const query = jest.spyOn(client, "query");
            await new Promise<void>((resolve, reject) => {
                submittable.once("error", reject);
                submittable.once("end", resolve);
                expect(ctx().query(submittable)).toBe(submittable);
            });
            expect(query.mock.calls[0][0]).toBe(submittable);
            const clock = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
            try {
                expect(() => ctx().query("SELECT 1")).toThrow(TransactionTimeoutError);
                expect(query).toHaveBeenCalledTimes(1);
            } finally { clock.mockRestore(); }
            throw failure;
        }, { timeout: 1000 })()).rejects.toBe(failure);
        expect(end).toHaveBeenCalledTimes(1);
    });

    it("resolves sync config factories per physical transaction and supports named registration", async () => {
        const name = Symbol("client-per-transaction");
        const config = jest.fn((): ClientConfig => ({ connectionString }));
        usePostgreSQLClientPerTransaction(config, name);
        try {
            for (let i = 0; i < 2; i++) await transactional(async () => {
                expect((await ctx(name).query("SELECT 42 AS value")).rows[0].value).toBe(42);
            }, { datasource: name })();
            expect(config).toHaveBeenCalledTimes(2);
            expect(end).toHaveBeenCalledTimes(2);
        } finally { useTransactionManager(undefined as any, name); }
    });

    it("isolates 50 concurrent calls on one module-scope registration with a stable backend per transaction", async () => {
        const config = jest.fn(async () => ({ connectionString }));
        usePostgreSQLClientPerTransaction(config);
        const manager = getTransactionManager();
        const backends = new Set<number>();
        let ready = 0;
        let release!: () => void;
        const allReady = new Promise<void>(resolve => { release = resolve; });
        await Promise.all(Array.from({ length: 50 }, (_, id) => transactional(async () => {
            expect(getTransactionManager()).toBe(manager);
            const client = ctx();
            const firstPid = await pid();
            backends.add(firstPid);
            await client.query(`INSERT INTO ${table} VALUES ($1)`, [id]);
            if (++ready === 50) release();
            await allReady;
            const result = await ctx().query(`SELECT id, pg_backend_pid() AS pid FROM ${table} WHERE id = $1`, [id]);
            expect(result.rows).toEqual([{ id, pid: firstPid }]);
            expect(ctx()).toBe(client);
        })()));
        expect(backends.size).toBe(50);
        expect(config).toHaveBeenCalledTimes(50);
        expect(end).toHaveBeenCalledTimes(50);
        expect(new Set(end.mock.contexts).size).toBe(50);
        expect(await ids()).toEqual(Array.from({ length: 50 }, (_, id) => id));
    });

    it.each(["idle-query", "idle-commit", "active-query"])(
        "survives backend termination in a child process (%s) and ends once", async scenario => {
            const { stdout, stderr } = await execFileAsync(process.execPath, [
                "--unhandled-rejections=strict", resolve(__dirname, "../../../scripts/test/connection-loss.cjs"), "pg", scenario,
            ], { timeout: 10000 });
            expect(stderr).toBe("");
            expect(JSON.parse(stdout)).toEqual({
                rejected: true, end: 1, destroy: 0,
                queryRejected: scenario !== "idle-commit", commitRejected: scenario === "idle-commit",
            });
        },
    );

    it("keeps implicit ctx on its owner while explicit default observes re-registration", async () => {
        // This deliberately reproduces unsupported registration inside a request handler.
        let started!: () => void;
        const firstStarted = new Promise<void>(resolve => { started = resolve; });
        let resume!: () => void;
        const secondFinished = new Promise<void>(resolve => { resume = resolve; });
        usePostgreSQLTransactionManager(pool);
        const first = transactional(async () => {
            const original = ctx();
            await original.query("SELECT 1");
            started();
            await secondFinished;
            expect(ctx()).toBe(original);
            await ctx().query("SELECT 2");
            await ctx(DEFAULT_DATASOURCE).query("SELECT 4");
        })();
        await firstStarted;
        usePostgreSQLTransactionManager(pool);
        const second = transactional(async () => { await ctx().query("SELECT 3"); })().finally(resume);
        const results = await Promise.allSettled([first, second]);
        expect(results[0]).toMatchObject({ status: "rejected", reason: new Error("Transaction context not initialized") });
        expect(results[1].status).toBe("fulfilled");
    });
});
