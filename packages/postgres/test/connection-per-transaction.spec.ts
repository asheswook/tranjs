import postgres from "postgres";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
    afterCommit,
    afterRollback,
    getTransactionManager,
    InvalidIsolationLevelError,
    IsolationLevel,
    PlatformTransactionManager,
    Propagation,
    runInTransaction,
    TransactionTimeoutError,
    UnexpectedRollbackError,
    useTransactionManager,
} from "@tranjs/core";
import {
    ctx,
    PostgresConnectionPerTransactionManager,
    TransactionAbortedError,
    usePostgresConnectionPerTransaction,
} from "../src";

// Keep all connections and queries real; instrument only the factory's lifecycle
// methods. Unlike a prototype spy this also sees pools that fail during reserve().
jest.mock("postgres", () => {
    const actual = jest.requireActual("postgres");
    const real = actual.default ?? actual;
    const factory = jest.fn((...args: any[]) => {
        const sql = real(...args);
        const reserve = sql.reserve.bind(sql);
        jest.spyOn(sql, "end");
        jest.spyOn(sql, "reserve").mockImplementation(async () => {
            const reserved = await reserve();
            jest.spyOn(reserved, "release");
            return reserved;
        });
        return sql;
    });
    return { ...actual, __esModule: true, default: Object.assign(factory, real) };
});

const url = process.env.PG_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const table = "tranjs_postgres_connection_per_transaction_test";
const failure = new Error("application failure");
const execFileAsync = promisify(execFile);
const factory = postgres as jest.MockedFunction<typeof postgres>;

describe("postgres.js connection per transaction (real database)", () => {
    const admin = postgres(url, { max: 2, onnotice: false });

    beforeAll(async () => {
        await admin.unsafe(`CREATE TABLE IF NOT EXISTS ${table} (id integer UNIQUE DEFERRABLE INITIALLY DEFERRED)`);
    });
    beforeEach(async () => {
        await admin.unsafe(`DELETE FROM ${table}`);
        factory.mockClear();
        usePostgresConnectionPerTransaction(url);
    });
    afterEach(() => { jest.restoreAllMocks(); });
    afterAll(async () => {
        await admin.unsafe(`DROP TABLE IF EXISTS ${table}`);
        await admin.end();
        useTransactionManager(undefined as any);
    });

    async function ids() {
        return (await admin.unsafe(`SELECT id FROM ${table} ORDER BY id`)).map(row => row.id);
    }
    async function pid() {
        return (await ctx()`SELECT pg_backend_pid() AS pid`)[0].pid as number;
    }
    function pools() {
        return factory.mock.results.filter(result => result.type === "return").map(result => result.value as postgres.Sql);
    }
    async function disposed(count = 1, reservedCount = count) {
        expect(factory).toHaveBeenCalledTimes(count);
        const reserved: postgres.ReservedSql[] = [];
        for (const sql of pools()) {
            expect(sql.end).toHaveBeenCalledTimes(1);
            expect(sql.end).toHaveBeenCalledWith({ timeout: 1 });
            expect(sql.reserve).toHaveBeenCalledTimes(1);
            const result = await Promise.allSettled((sql.reserve as jest.Mock).mock.results.map(call => call.value));
            for (const item of result) {
                if (item.status === "fulfilled") {
                    expect(item.value.release).toHaveBeenCalledTimes(1);
                    reserved.push(item.value);
                }
            }
        }
        expect(reserved).toHaveLength(reservedCount);
        expect(new Set(reserved).size).toBe(reservedCount);
    }

    it("commits and releases the reservation and ends its owner pool exactly once", async () => {
        expect(await runInTransaction(async () => {
            await ctx().unsafe(`INSERT INTO ${table} VALUES (1)`);
            return 42;
        })).toBe(42);
        await disposed();
        expect(await ids()).toEqual([1]);
    });

    it("rolls back a callback throw and cleans up exactly once", async () => {
        await expect(runInTransaction(async () => {
            await ctx().unsafe(`INSERT INTO ${table} VALUES (1)`);
            throw failure;
        })).rejects.toBe(failure);
        await disposed();
        expect(await ids()).toEqual([]);
    });

    it("does not roll back committed data when afterCommit throws", async () => {
        const rollback = jest.fn();
        await expect(runInTransaction(async () => {
            await ctx().unsafe(`INSERT INTO ${table} VALUES (1)`);
            afterCommit(() => { throw failure; });
            afterRollback(rollback);
        })).rejects.toBe(failure);
        await disposed();
        expect(rollback).not.toHaveBeenCalled();
        expect(await ids()).toEqual([1]);
    });

    it("rolls back a swallowed joined failure and cleans up exactly once", async () => {
        await expect(runInTransaction(async () => {
            await ctx().unsafe(`INSERT INTO ${table} VALUES (1)`);
            await expect(runInTransaction(async () => {
                await ctx().unsafe(`INSERT INTO ${table} VALUES (2)`);
                throw failure;
            })).rejects.toBe(failure);
        })).rejects.toThrow(UnexpectedRollbackError);
        await disposed();
        expect(await ids()).toEqual([]);
    });

    it("cleans up exactly once after a real deferred-constraint COMMIT failure", async () => {
        await expect(runInTransaction(async () => {
            await ctx().unsafe(`INSERT INTO ${table} VALUES (1), (1)`);
        })).rejects.toMatchObject({ code: "23505" });
        await disposed();
        expect(await ids()).toEqual([]);
    });

    it("reports a caught duplicate-key error as TransactionAbortedError and runs rollback hooks", async () => {
        const rollback = jest.fn();
        const commit = jest.fn();
        await expect(runInTransaction(async () => {
            afterCommit(commit);
            afterRollback(rollback);
            await ctx().unsafe("SET CONSTRAINTS ALL IMMEDIATE");
            await ctx().unsafe(`INSERT INTO ${table} VALUES (1)`);
            await expect(ctx().unsafe(`INSERT INTO ${table} VALUES (1)`)).rejects.toMatchObject({ code: "23505" });
        })).rejects.toThrow(TransactionAbortedError);
        await disposed();
        expect(rollback).toHaveBeenCalledTimes(1);
        expect(commit).not.toHaveBeenCalled();
        expect(await ids()).toEqual([]);
    });

    it("cleans up exactly once after ROLLBACK fails", async () => {
        const rollbackError = new Error("injected rollback failure");
        getTransactionManager().setLogger({ error() {}, info() {}, warn() {}, debug() {} });
        await expect(runInTransaction(async () => {
            await ctx().unsafe(`INSERT INTO ${table} VALUES (1)`);
            const raw = getTransactionManager().getCurrentTransaction() as postgres.ReservedSql;
            jest.spyOn(raw, "unsafe").mockImplementationOnce(() => Promise.reject(rollbackError) as any);
            throw failure;
        })).rejects.toMatchObject({ name: "TransactionSystemError", cause: rollbackError, applicationError: failure });
        await disposed();
        expect(await ids()).toEqual([]);
    });

    it("ends its owner pool once after a real connect failure without a reservation to release", async () => {
        const invalidUrl = new URL(url);
        invalidUrl.password = "incorrect-password";
        usePostgresConnectionPerTransaction(invalidUrl.toString());
        await expect(runInTransaction(async () => {})).rejects.toMatchObject({ code: "28P01" });
        await disposed(1, 0);
    });

    it.each([false, true])("cleans up once after BEGIN fails (rollback also fails: %s)", async rollbackFails => {
        const create = factory.getMockImplementation()!;
        const beginError = new Error("BEGIN reported failure after succeeding");
        let unsafe!: jest.SpyInstance;
        factory.mockImplementationOnce(((...args: any[]) => {
            const sql = (create as any)(...args) as postgres.Sql;
            const reserve = (sql.reserve as jest.Mock).getMockImplementation()!;
            (sql.reserve as jest.Mock).mockImplementation(async () => {
                const raw = await reserve() as postgres.ReservedSql;
                const run = raw.unsafe.bind(raw);
                unsafe = jest.spyOn(raw, "unsafe").mockImplementation(((statement: string, ...params: any[]) => {
                    if (statement === "ROLLBACK" && rollbackFails) return Promise.reject(new Error("rollback failed"));
                    const result = (run as any)(statement, ...params);
                    if (/^BEGIN\b/.test(statement)) return result.then(async () => {
                        await run(`INSERT INTO ${table} VALUES (1)`);
                        throw beginError;
                    });
                    return result;
                }) as any);
                return raw;
            });
            return sql;
        }) as any);
        await expect(runInTransaction(async () => { throw new Error("must not run"); })).rejects.toBe(beginError);
        expect(unsafe.mock.calls.map(([statement]) => statement)).toEqual([expect.stringMatching(/^BEGIN\b/), "ROLLBACK"]);
        await disposed();
        expect(await ids()).toEqual([]);
    });

    it.each([false, true])("logs end failures without masking the outcome (callback throws: %s)", async throws => {
        const cleanupError = new Error("end reported failure after closing");
        const log = jest.fn(() => { throw new Error("logger failed too"); });
        getTransactionManager().setLogger({ error: log, info() {}, warn() {}, debug() {} });
        const result = runInTransaction(async () => {
            const sql = pools()[0];
            const end = sql.end as jest.Mock;
            const close = end.getMockImplementation()!;
            end.mockImplementation(async (...args: any[]) => {
                await close(...args);
                throw cleanupError;
            });
            await ctx().unsafe(`INSERT INTO ${table} VALUES (1)`);
            if (throws) throw failure;
            return 42;
        });
        if (throws) await expect(result).rejects.toBe(failure);
        else await expect(result).resolves.toBe(42);
        await disposed();
        expect(log).toHaveBeenCalledWith("Postgres connection cleanup failed", cleanupError);
        expect(await ids()).toEqual(throws ? [] : [1]);
    });

    it("validates isolation before resolving configuration or constructing a pool", async () => {
        const config = jest.fn(() => url);
        const manager = new PostgresConnectionPerTransactionManager(config);
        expect(manager).toBeInstanceOf(PlatformTransactionManager);
        await expect((manager as any).beginTransaction({ isolationLevel: "READ COMMITTED; COMMIT" }))
            .rejects.toThrow(InvalidIsolationLevelError);
        useTransactionManager(manager);
        await expect(runInTransaction(async () => {}, { isolationLevel: "invalid" as IsolationLevel }))
            .rejects.toThrow(InvalidIsolationLevelError);
        expect(config).not.toHaveBeenCalled();
        expect(factory).not.toHaveBeenCalled();
    });

    it("applies isolation and rejects read-only writes", async () => {
        await expect(runInTransaction(async () => {
            expect((await ctx()`SELECT current_setting('transaction_isolation') AS value`)[0].value).toBe("serializable");
            expect((await ctx()`SELECT current_setting('transaction_read_only') AS value`)[0].value).toBe("on");
            await ctx().unsafe(`INSERT INTO ${table} VALUES (1)`);
        }, { isolationLevel: IsolationLevel.SERIALIZABLE, readOnly: true })).rejects.toMatchObject({ code: "25006" });
        await disposed();
        expect(await ids()).toEqual([]);
    });

    it("NESTED uses savepoints without opening or ending another owner pool", async () => {
        await runInTransaction(async () => {
            const outer = ctx();
            const outerPid = await pid();
            await ctx().unsafe(`INSERT INTO ${table} VALUES (1)`);
            await expect(runInTransaction(async () => {
                expect(ctx()).toBe(outer);
                expect(await pid()).toBe(outerPid);
                await ctx().unsafe(`INSERT INTO ${table} VALUES (2)`);
                throw failure;
            }, { propagation: Propagation.NESTED })).rejects.toBe(failure);
            await runInTransaction(async () => { await ctx().unsafe(`INSERT INTO ${table} VALUES (3)`); }, { propagation: Propagation.NESTED });
            expect(factory).toHaveBeenCalledTimes(1);
            expect(pools()[0].end).not.toHaveBeenCalled();
        });
        await disposed();
        expect(await ids()).toEqual([1, 3]);
    });

    it("REQUIRES_NEW owns another backend and survives outer rollback", async () => {
        await expect(runInTransaction(async () => {
            const outer = ctx();
            const outerPid = await pid();
            await ctx().unsafe(`INSERT INTO ${table} VALUES (1)`);
            await runInTransaction(async () => {
                expect(ctx()).not.toBe(outer);
                expect(await pid()).not.toBe(outerPid);
                expect(await ctx().unsafe(`SELECT id FROM ${table}`)).toHaveLength(0);
                await ctx().unsafe(`INSERT INTO ${table} VALUES (2)`);
            }, { propagation: Propagation.REQUIRES_NEW });
            expect(pools()[1].end).toHaveBeenCalledTimes(1);
            expect(pools()[0].end).not.toHaveBeenCalled();
            expect(ctx()).toBe(outer);
            expect(await pid()).toBe(outerPid);
            throw failure;
        })).rejects.toBe(failure);
        await disposed(2);
        expect(await ids()).toEqual([2]);
    });

    it.each(["tagged", "unsafe", "execute"])("cancels slow %s queries and cleans up once", async format => {
        await expect(runInTransaction(async () => {
            await ctx().unsafe(`INSERT INTO ${table} VALUES (1)`);
            const query = format === "unsafe" ? ctx().unsafe("SELECT pg_sleep($1)", [0.3]) : ctx()`SELECT pg_sleep(${0.3})`;
            if (format === "execute") await query.execute();
            else await query;
        }, { timeout: 100 })).rejects.toThrow(TransactionTimeoutError);
        await disposed();
        expect(await ids()).toEqual([]);
    });

    it("resolves synchronous config factories per physical transaction and supports named registration", async () => {
        const name = Symbol("postgres-connection-per-transaction");
        const parsed = new URL(url);
        const config = jest.fn((): postgres.Options<{}> => ({
            host: parsed.hostname, port: Number(parsed.port || 5432),
            user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password),
            database: decodeURIComponent(parsed.pathname.slice(1)), onnotice: false,
        }));
        usePostgresConnectionPerTransaction(config, name);
        try {
            for (let i = 0; i < 2; i++) await runInTransaction(async () => {
                expect((await ctx(name)`SELECT 42 AS value`)[0].value).toBe(42);
            }, { datasource: name });
            expect(config).toHaveBeenCalledTimes(2);
            await disposed(2);
        } finally { useTransactionManager(undefined as any, name); }
    });

    it("isolates 50 concurrent calls with stable backends and leaves no owner sessions behind", async () => {
        const applicationName = `tranjs-postgres-owned-${process.pid}`;
        const ownedUrl = new URL(url);
        ownedUrl.searchParams.set("application_name", applicationName);
        const config = jest.fn(async () => ownedUrl.toString());
        usePostgresConnectionPerTransaction(config);
        const manager = getTransactionManager();
        const backends = new Set<number>();
        let ready = 0;
        let release!: () => void;
        const allReady = new Promise<void>(resolve => { release = resolve; });
        await Promise.all(Array.from({ length: 50 }, (_, id) => runInTransaction(async () => {
            expect(getTransactionManager()).toBe(manager);
            const connection = ctx();
            const firstPid = await pid();
            backends.add(firstPid);
            await connection.unsafe(`INSERT INTO ${table} VALUES ($1)`, [id]);
            if (++ready === 50) release();
            await allReady;
            expect(await ctx().unsafe(`SELECT id, pg_backend_pid() AS pid FROM ${table} WHERE id = $1`, [id]))
                .toEqual([{ id, pid: firstPid }]);
            expect(ctx()).toBe(connection);
        })));
        expect(backends.size).toBe(50);
        expect(config).toHaveBeenCalledTimes(50);
        await disposed(50);
        expect(await ids()).toEqual(Array.from({ length: 50 }, (_, id) => id));
        const rows = await admin`SELECT pid FROM pg_stat_activity WHERE application_name = ${applicationName}`;
        expect(rows).toHaveLength(0);
    });

    it.each(["idle-query", "idle-commit", "active-query"])(
        "survives backend termination in a child process (%s) and releases and ends once", async scenario => {
            const { stdout, stderr } = await execFileAsync(process.execPath, [
                "--unhandled-rejections=strict", resolve(__dirname, "../../../scripts/test/connection-loss.cjs"), "postgres", scenario,
            ], { timeout: 10000 });
            expect(stderr).toBe("");
            expect(JSON.parse(stdout)).toEqual({
                rejected: true, end: 1, poolEnd: 1, destroy: 0,
                queryRejected: scenario !== "idle-commit", commitRejected: scenario === "idle-commit",
            });
        },
    );
});
