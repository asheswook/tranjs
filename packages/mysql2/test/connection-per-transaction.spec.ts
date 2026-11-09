import mysql = require("mysql2");
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Connection, ConnectionOptions, createPool, RowDataPacket } from "mysql2/promise";
import {
    afterCommit,
    getTransactionManager,
    InvalidIsolationLevelError,
    IsolationLevel,
    PlatformTransactionManager,
    Propagation,
    runInTransaction,
    TransactionContextMixingError,
    TransactionTimeoutError,
    UnexpectedRollbackError,
    useTransactionManager,
} from "@tranjs/core";
import {
    ctx,
    MySQLConnectionPerTransactionManager,
    UnsupportedIsolationLevelError,
    useMySQLConnectionPerTransaction,
} from "../src";

const url = process.env.MYSQL_URL ?? "mysql://root:root@localhost:3306/test";
const table = "tranjs_mysql_connection_per_transaction_test";
const failure = new Error("application failure");
const execFileAsync = promisify(execFile);

describe("MySQL connection per transaction (real database)", () => {
    const pool = createPool({ uri: url, connectionLimit: 2 });
    let created: { connection: Connection; end: jest.SpyInstance }[];
    let create: jest.SpyInstance;
    let configure: ((connection: Connection, end: jest.SpyInstance) => void) | undefined;

    beforeAll(async () => {
        await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (id integer PRIMARY KEY, value integer NOT NULL DEFAULT 0) ENGINE=InnoDB`);
    });
    beforeEach(async () => {
        await pool.query(`DELETE FROM ${table}`);
        useMySQLConnectionPerTransaction({ uri: url });
        created = [];
        configure = undefined;
        const originalCreate = mysql.createConnection;
        create = jest.spyOn(mysql, "createConnection").mockImplementation(config => {
            const raw = originalCreate(config);
            const promise = raw.promise.bind(raw);
            jest.spyOn(raw, "promise").mockImplementation(implementation => {
                const connection = promise(implementation);
                const end = jest.spyOn(connection, "end");
                created.push({ connection, end });
                configure?.(connection, end);
                return connection;
            });
            return raw;
        });
    });
    afterEach(() => {
        try {
            // Every connection created in every test must be ended exactly once.
            for (const { end } of created) expect(end).toHaveBeenCalledTimes(1);
        } finally { jest.restoreAllMocks(); }
    });
    afterAll(async () => {
        await pool.query(`DROP TABLE IF EXISTS ${table}`);
        await pool.end();
        useTransactionManager(undefined as any);
    });

    async function ids() {
        const [rows] = await pool.query<RowDataPacket[]>(`SELECT id FROM ${table} ORDER BY id`);
        return rows.map(row => row.id);
    }
    async function connectionId() {
        const [rows] = await ctx().query<RowDataPacket[]>("SELECT CONNECTION_ID() AS id");
        return rows[0].id;
    }

    it("commits and ends the connection exactly once", async () => {
        expect(await runInTransaction(async () => {
            await ctx().query(`INSERT INTO ${table} (id) VALUES (1)`);
            return 42;
        })).toBe(42);
        expect(created).toHaveLength(1);
        expect(created[0].end).toHaveBeenCalledTimes(1);
        expect(await ids()).toEqual([1]);
    });

    it("rolls back a callback throw and ends the connection exactly once", async () => {
        await expect(runInTransaction(async () => {
            await ctx().query(`INSERT INTO ${table} (id) VALUES (1)`);
            throw failure;
        })).rejects.toBe(failure);
        expect(created).toHaveLength(1);
        expect(created[0].end).toHaveBeenCalledTimes(1);
        expect(await ids()).toEqual([]);
    });

    it("preserves committed data and ends once when afterCommit throws", async () => {
        await expect(runInTransaction(async () => {
            await ctx().query(`INSERT INTO ${table} (id) VALUES (1)`);
            afterCommit(() => { throw failure; });
        })).rejects.toBe(failure);
        expect(created).toHaveLength(1);
        expect(created[0].end).toHaveBeenCalledTimes(1);
        expect(await ids()).toEqual([1]);
    });

    it("rolls back and ends once after a swallowed joined failure", async () => {
        await expect(runInTransaction(async () => {
            await ctx().query(`INSERT INTO ${table} (id) VALUES (1)`);
            await expect(runInTransaction(async () => {
                await ctx().query(`INSERT INTO ${table} (id) VALUES (2)`);
                throw failure;
            })).rejects.toBe(failure);
        })).rejects.toThrow(UnexpectedRollbackError);
        expect(created).toHaveLength(1);
        expect(created[0].end).toHaveBeenCalledTimes(1);
        expect(await ids()).toEqual([]);
    });

    it("ends once after COMMIT failure without attempting rollback", async () => {
        const commitError = new Error("injected COMMIT failure");
        let rollback!: jest.SpyInstance;
        await expect(runInTransaction(async () => {
            const connection = getTransactionManager().getCurrentTransaction() as Connection;
            await ctx().query(`INSERT INTO ${table} (id) VALUES (1)`);
            // MySQL has no deferred constraints: fail COMMIT on a real connection.
            jest.spyOn(connection, "commit").mockRejectedValueOnce(commitError);
            rollback = jest.spyOn(connection, "rollback");
        })).rejects.toBe(commitError);
        expect(rollback).not.toHaveBeenCalled();
        expect(created).toHaveLength(1);
        expect(created[0].end).toHaveBeenCalledTimes(1);
        expect(await ids()).toEqual([]);
    });

    it("ends once after ROLLBACK failure and retains both errors", async () => {
        const rollbackError = new Error("injected ROLLBACK failure");
        jest.spyOn(console, "error").mockImplementation(() => {});
        await expect(runInTransaction(async () => {
            await ctx().query(`INSERT INTO ${table} (id) VALUES (1)`);
            const connection = getTransactionManager().getCurrentTransaction() as Connection;
            jest.spyOn(connection, "rollback").mockRejectedValueOnce(rollbackError);
            throw failure;
        })).rejects.toMatchObject({ name: "TransactionSystemError", cause: rollbackError, applicationError: failure });
        expect(created).toHaveLength(1);
        expect(created[0].end).toHaveBeenCalledTimes(1);
        expect(await ids()).toEqual([]);
    });

    it("ends once after a real handshake/connect failure", async () => {
        const invalidUrl = new URL(url);
        invalidUrl.password = "incorrect-password";
        useMySQLConnectionPerTransaction({ uri: invalidUrl.toString() });
        await expect(runInTransaction(async () => { throw new Error("must not run"); }))
            .rejects.toMatchObject({ code: "ER_ACCESS_DENIED_ERROR" });
        expect(create).toHaveBeenCalledTimes(1);
        expect(created).toHaveLength(1);
        expect(created[0].end).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])("cleans up START failure exactly once (rollback fails: %s)", async rollbackFails => {
        const startError = new Error("START reported failure after succeeding");
        let rollback!: jest.SpyInstance;
        configure = connection => {
            const query = connection.query.bind(connection);
            jest.spyOn(connection, "query").mockImplementation((async (sql: string) => {
                const result = await query(sql);
                if (sql === "START TRANSACTION") {
                    await query(`INSERT INTO ${table} (id) VALUES (1)`);
                    throw startError;
                }
                return result;
            }) as any);
            rollback = jest.spyOn(connection, "rollback");
            if (rollbackFails) rollback.mockRejectedValueOnce(new Error("injected rollback failure"));
        };
        await expect(runInTransaction(async () => { throw new Error("must not run"); })).rejects.toBe(startError);
        expect(rollback).toHaveBeenCalledTimes(1);
        expect(created).toHaveLength(1);
        expect(created[0].end).toHaveBeenCalledTimes(1);
        expect(await ids()).toEqual([]);
    });

    it("cleans up a failed SET in apply mode before START", async () => {
        const setError = new Error("injected SET failure");
        let query!: jest.SpyInstance;
        configure = connection => { query = jest.spyOn(connection, "query").mockRejectedValueOnce(setError); };
        useMySQLConnectionPerTransaction({ uri: url }, undefined, { isolationLevelSupport: "apply" });
        await expect(runInTransaction(async () => {}, { isolationLevel: IsolationLevel.READ_COMMITTED }))
            .rejects.toBe(setError);
        expect(query.mock.calls).toEqual([["SET TRANSACTION ISOLATION LEVEL READ COMMITTED"]]);
        expect(created).toHaveLength(1);
    });

    it.each(["success", "callback", "connect", "START"])(
        "logs end errors without masking the %s outcome, even if the logger throws", async path => {
            const cleanupError = new Error("end reported failure");
            const primaryError = new Error(`injected ${path} failure`);
            configure = (connection, end) => {
                const originalEnd = end.getMockImplementation()!;
                end.mockImplementation(async () => { await originalEnd.call(connection); throw cleanupError; });
                const connect = connection.connect.bind(connection);
                if (path === "connect") jest.spyOn(connection, "connect").mockImplementationOnce(async () => {
                    // Complete the real handshake before reporting an injected failure.
                    // The real handshake failure path is tested separately above.
                    await connect();
                    throw primaryError;
                });
                if (path === "START") jest.spyOn(connection, "query").mockRejectedValueOnce(primaryError);
            };
            const log = jest.fn(() => { throw new Error("logger failed too"); });
            getTransactionManager().setLogger({ error: log, info() {}, warn() {}, debug() {} });
            const result = runInTransaction(async () => {
                await ctx().query(`INSERT INTO ${table} (id) VALUES (1)`);
                if (path === "callback") throw primaryError;
                return 42;
            });
            if (path === "success") await expect(result).resolves.toBe(42);
            else await expect(result).rejects.toBe(primaryError);
            expect(created).toHaveLength(1);
            expect(log).toHaveBeenCalledWith("MySQL connection cleanup failed", cleanupError);
            expect(await ids()).toEqual(path === "success" ? [1] : []);
        },
    );

    it("uses one connection and savepoints for NESTED", async () => {
        await runInTransaction(async () => {
            const outer = ctx();
            const outerId = await connectionId();
            await ctx().query(`INSERT INTO ${table} (id) VALUES (1)`);
            await expect(runInTransaction(async () => {
                expect(ctx()).toBe(outer);
                expect(await connectionId()).toBe(outerId);
                await ctx().query(`INSERT INTO ${table} (id) VALUES (2)`);
                throw failure;
            }, { propagation: Propagation.NESTED })).rejects.toBe(failure);
            await runInTransaction(async () => {
                await ctx().query(`INSERT INTO ${table} (id) VALUES (3)`);
            }, { propagation: Propagation.NESTED });
            expect(created).toHaveLength(1);
            expect(created[0].end).not.toHaveBeenCalled();
        });
        expect(await ids()).toEqual([1, 3]);
    });

    it("opens a second connection for REQUIRES_NEW and restores the outer connection", async () => {
        await expect(runInTransaction(async () => {
            const outer = ctx();
            const outerId = await connectionId();
            await ctx().query(`INSERT INTO ${table} (id) VALUES (1)`);
            await runInTransaction(async () => {
                expect(ctx()).not.toBe(outer);
                expect(await connectionId()).not.toBe(outerId);
                const [rows] = await ctx().query<RowDataPacket[]>(`SELECT id FROM ${table}`);
                expect(rows).toEqual([]);
                await ctx().query(`INSERT INTO ${table} (id) VALUES (2)`);
            }, { propagation: Propagation.REQUIRES_NEW });
            expect(created[1].end).toHaveBeenCalledTimes(1);
            expect(created[0].end).not.toHaveBeenCalled();
            expect(ctx()).toBe(outer);
            expect(await connectionId()).toBe(outerId);
            throw failure;
        })).rejects.toBe(failure);
        expect(created).toHaveLength(2);
        expect(await ids()).toEqual([2]);
    });

    it("blocks read-only writes on direct MySQL and rolls back", async () => {
        await expect(runInTransaction(async () => {
            await ctx().query(`INSERT INTO ${table} (id) VALUES (1)`);
        }, { readOnly: true })).rejects.toMatchObject({ code: "ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION" });
        expect(created).toHaveLength(1);
        expect(await ids()).toEqual([]);
    });

    it.each(["query", "execute"] as const)("applies the deadline to %s and rolls back", async method => {
        await expect(runInTransaction(async () => {
            await ctx().query(`INSERT INTO ${table} (id) VALUES (1)`);
            if (method === "query") await ctx().query("SELECT SLEEP(?)", [0.2]);
            else await ctx().execute("SELECT SLEEP(?)", [0.2]);
        }, { timeout: 75 })).rejects.toThrow(TransactionTimeoutError);
        expect(created).toHaveLength(1);
        expect(await ids()).toEqual([]);
    });

    it("rejects an expired deadline before dispatch", async () => {
        await expect(runInTransaction(async () => {
            const query = jest.spyOn(created[0].connection, "query");
            const clock = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
            try {
                expect(() => ctx().query("SELECT 1")).toThrow(TransactionTimeoutError);
                expect(query).not.toHaveBeenCalled();
            } finally { clock.mockRestore(); }
            throw failure;
        }, { timeout: 1000 })).rejects.toBe(failure);
        expect(created).toHaveLength(1);
    });

    it.each([undefined, "reject"] as const)("rejects isolation before connecting (policy: %s)", async isolationLevelSupport => {
        const config = jest.fn(() => ({ uri: url }));
        const manager = new MySQLConnectionPerTransactionManager(config, { isolationLevelSupport });
        expect(manager).toBeInstanceOf(PlatformTransactionManager);
        useTransactionManager(manager);
        for (const level of Object.values(IsolationLevel)) {
            await expect(runInTransaction(async () => {}, { isolationLevel: level }))
                .rejects.toBeInstanceOf(UnsupportedIsolationLevelError);
            await expect((manager as any).beginTransaction({ isolationLevel: level }))
                .rejects.toMatchObject({
                    name: "UnsupportedIsolationLevelError", isolationLevel: level,
                    message: expect.stringContaining("silently ignored through Cloudflare Hyperdrive"),
                });
        }
        expect(config).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
        expect(created).toHaveLength(0);
    });

    it("validates isolation SQL even with apply enabled, before connecting", async () => {
        const manager = new MySQLConnectionPerTransactionManager({ uri: url }, { isolationLevelSupport: "apply" });
        await expect((manager as any).beginTransaction({ isolationLevel: "READ COMMITTED; COMMIT" }))
            .rejects.toThrow(InvalidIsolationLevelError);
        useTransactionManager(manager);
        await expect(runInTransaction(async () => {}, { isolationLevel: "invalid" as IsolationLevel }))
            .rejects.toThrow(InvalidIsolationLevelError);
        expect(create).not.toHaveBeenCalled();
    });

    it.each([
        { level: IsolationLevel.READ_COMMITTED, expected: 1 },
        { level: IsolationLevel.REPEATABLE_READ, expected: 0 },
    ])("apply mode gives behavioural $level isolation on direct MySQL", async ({ level, expected }) => {
        await pool.query(`INSERT INTO ${table} (id, value) VALUES (1, 0)`);
        useMySQLConnectionPerTransaction({ uri: url }, undefined, { isolationLevelSupport: "apply" });
        await runInTransaction(async () => {
            const [before] = await ctx().query<RowDataPacket[]>(`SELECT value FROM ${table} WHERE id = 1`);
            expect(before[0].value).toBe(0);
            // Commit on a second connection while the first transaction remains open.
            await runInTransaction(async () => {
                await ctx().query(`UPDATE ${table} SET value = 1 WHERE id = 1`);
            }, { propagation: Propagation.REQUIRES_NEW });
            const [after] = await ctx().query<RowDataPacket[]>(`SELECT value FROM ${table} WHERE id = 1`);
            expect(after[0].value).toBe(expected);
        }, { isolationLevel: level });
        expect(created).toHaveLength(2);
    });

    it("resolves sync factories per physical transaction and supports named registration", async () => {
        const name = Symbol("connection-per-transaction");
        const config = jest.fn((): ConnectionOptions => ({ uri: url }));
        useMySQLConnectionPerTransaction(config, name);
        try {
            for (let i = 0; i < 2; i++) await runInTransaction(async () => {
                const [rows] = await ctx(name).query<RowDataPacket[]>("SELECT 42 AS value");
                expect(rows[0].value).toBe(42);
            }, { datasource: name });
            expect(config).toHaveBeenCalledTimes(2);
            expect(created).toHaveLength(2);
        } finally { useTransactionManager(undefined as any, name); }
    });

    it("isolates 50 concurrent transactions on one registration with stable connection ids", async () => {
        const config = jest.fn(async () => ({ uri: url }));
        useMySQLConnectionPerTransaction(config);
        const manager = getTransactionManager();
        const backends = new Set<number>();
        let ready = 0;
        let release!: () => void;
        const allReady = new Promise<void>(resolve => { release = resolve; });
        await Promise.all(Array.from({ length: 50 }, (_, id) => runInTransaction(async () => {
            expect(getTransactionManager()).toBe(manager);
            const connection = ctx();
            const firstId = await connectionId();
            backends.add(firstId);
            await ctx().query(`INSERT INTO ${table} (id) VALUES (?)`, [id]);
            if (++ready === 50) release();
            await allReady;
            const [rows] = await ctx().query<RowDataPacket[]>(
                `SELECT id, CONNECTION_ID() AS connectionId FROM ${table} WHERE id = ?`, [id],
            );
            expect(rows).toEqual([{ id, connectionId: firstId }]);
            expect(ctx()).toBe(connection);
        })));
        expect(backends.size).toBe(50);
        expect(config).toHaveBeenCalledTimes(50);
        expect(created).toHaveLength(50);
        expect(new Set(created.map(({ connection }) => connection)).size).toBe(50);
        expect(await ids()).toEqual(Array.from({ length: 50 }, (_, id) => id));
    });

    it.each(["idle-query", "idle-commit", "active-query"])(
        "survives KILL CONNECTION in a child process (%s) and ends/destroys once", async scenario => {
            const { stdout, stderr } = await execFileAsync(process.execPath, [
                "--unhandled-rejections=strict", resolve(__dirname, "../../../scripts/test/connection-loss.cjs"), "mysql2", scenario,
            ], { timeout: 10000 });
            expect(stderr).toBe("");
            expect(JSON.parse(stdout)).toEqual({
                rejected: true, end: 1, destroy: 1,
                queryRejected: scenario !== "idle-commit", commitRejected: scenario === "idle-commit",
            });
        },
    );

    it("retains context errors outside a transaction and for foreign managers", async () => {
        expect(() => ctx()).toThrow("Transaction context not initialized");
        class OtherManager extends PlatformTransactionManager<object> {
            constructor() { super(); }
            protected async beginTransaction() { return { metadata: { driverName: Symbol("other") }, transaction: {} }; }
            protected async commitTransaction() {}
            protected async rollbackTransaction() {}
        }
        useTransactionManager(new OtherManager());
        await runInTransaction(async () => { expect(() => ctx()).toThrow(TransactionContextMixingError); });
    });
});
