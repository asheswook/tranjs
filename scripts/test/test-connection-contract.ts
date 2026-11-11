import { AsyncResource } from "node:async_hooks";
import {
    afterCommit, afterRollback, clearTransactionManager, Propagation, transactional,
    Transactional, TransactionClosedError, TransactionTimeoutError, useTransactionManager,
} from "@tranjs/core";
import { withTestConnection, mockTransactions, withTestTransaction } from "@tranjs/testing";

// Shared by all real-driver suites, including the isolated postgres-v3 runner
// (which copies scripts/test). Deliberately use any for hostile API invocations.
export interface TestConnectionDriver {
    kind: "pg" | "mysql2" | "postgres";
    manager: any;
    otherManager: any;
    ambient: (datasource: symbol) => any;
    outside: (text: string) => Promise<any>;
    rows: (result: any) => any[];
    query: (db: any, text: string, values?: any[]) => Promise<any>;
    close: () => Promise<void>;
    nativeError: (error: unknown) => void;
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

// Follow error wrappers, not arbitrary returned withTestConnection data. Identity matters:
// native SQL and injected cleanup failures must not be replaced by messages.
function errors(error: unknown, seen = new Set<unknown>()): unknown[] {
    if (seen.has(error)) return [];
    seen.add(error);
    const result = [error];
    if (error && typeof error === "object") {
        const e = error as any;
        for (const child of [...(Array.isArray(e.errors) ? e.errors : []), e.cause, e.applicationError]) {
            if (child !== undefined) result.push(...errors(child, seen));
        }
    }
    return result;
}

async function rejected(operation: Promise<unknown>): Promise<unknown> {
    try { await operation; } catch (error) { return error; }
    throw new Error("Expected operation to reject");
}

export function testConnectionContract(label: string, create: (options: { maxConnections: number }) => TestConnectionDriver) {
    describe(`withTestConnection / ${label} (real database)`, () => {
        const datasource = Symbol(label);
        const other = Symbol(`${label}-other`);
        const named = `withTestConnection-${label}`;
        const table = `tranjs_connection_${label.replace(/[^a-z0-9]/gi, "_")}`;
        const failure = new Error("withTestConnection callback failure");
        let driver: TestConnectionDriver;
        let dispatches: jest.Mock;
        const fix = <R>(fn: (db: any) => R) => withTestConnection(fn, { datasource });
        const test = <R>(fn: Parameters<typeof withTestTransaction<R>>[0]) =>
            withTestTransaction(fn, { datasource });
        const tx = <R>(fn: () => R, config: any = {}) => transactional(fn, { datasource, ...config })();
        const query = (db: any, text: string, values?: any[]) => driver.query(db, text, values);
        const insert = (db: any, id: number) => query(db, `INSERT INTO ${table} VALUES (${id})`);
        const ids = async (db: any) => driver.rows(await query(db, `SELECT id FROM ${table} ORDER BY id`))
            .map(row => Number(row.id));
        const ambient = () => driver.ambient(datasource);
        const slow = (db: any) => query(db, driver.kind === "mysql2"
            ? "SELECT SLEEP(0.08) AS n" : "SELECT pg_sleep(0.08) AS n");
        // Capture methods while their owner is live, including explicitly bound
        // methods and the callable postgres tag. Late property lookup alone must
        // not be the only thing protecting an escaped connection.
        const lateOperations = (db: any): (() => unknown)[] => {
            const methods = driver.kind === "postgres" ? ["unsafe"]
                : driver.kind === "mysql2" ? ["query", "execute"] : ["query"];
            const operations: (() => unknown)[] = [];
            for (const method of methods) {
                const bound = db[method].bind(db);
                const nullBound = db[method].bind(null);
                operations.push(() => db[method](`INSERT INTO ${table} VALUES (901)`));
                operations.push(() => bound(`INSERT INTO ${table} VALUES (902)`));
                operations.push(() => nullBound(`INSERT INTO ${table} VALUES (907)`));
            }
            const value = db.valueOf();
            operations.push(() => query(value, `INSERT INTO ${table} VALUES (906)`));
            if (driver.kind === "postgres") {
                const bound = Function.prototype.bind.call(db, undefined);
                const memberBound = db.bind(null);
                const identifier = db(table);
                operations.push(() => db`SELECT ${903}::integer AS n`);
                operations.push(() => bound`SELECT ${904}::integer AS n`);
                operations.push(() => memberBound`INSERT INTO ${identifier} VALUES (${905})`);
                operations.push(() => value`INSERT INTO ${identifier} VALUES (${910})`);
                operations.push(() => db.bind(null)`INSERT INTO ${identifier} VALUES (${908})`);
                operations.push(() => db.valueOf()`INSERT INTO ${identifier} VALUES (${909})`);
            }
            return operations;
        };
        const assertClosed = async (operations: (() => unknown)[]) => {
            const before = dispatches.mock.calls.length;
            for (const operation of operations) {
                const error = await rejected(Promise.resolve().then(operation));
                expect(error).toBeInstanceOf(TransactionClosedError);
                expect(error).toHaveProperty("message", "Transaction already finished");
                expect(dispatches).toHaveBeenCalledTimes(before);
            }
        };

        beforeAll(async () => {
            // Reuse the same one-connection pool across cases: leaked work cannot
            // hide behind a different checkout in the following test/session.
            driver = create({ maxConnections: 1 });
            await driver.outside(`CREATE TABLE IF NOT EXISTS ${table} (id integer PRIMARY KEY)${driver.kind === "mysql2" ? " ENGINE=InnoDB" : ""}`);
            useTransactionManager(driver.manager, datasource);
            useTransactionManager(driver.manager, named);
            useTransactionManager(driver.otherManager, other);
        });
        beforeEach(async () => {
            await driver.outside(`DELETE FROM ${table}`);
            dispatches = jest.fn();
            // Observe real native query entry, not the restricted facade. This also
            // covers fresh physical connections in per-transaction manager modes.
            const begin = driver.manager.beginTransaction.bind(driver.manager);
            const observed = new WeakMap<object, any>();
            const nativeTransactions = new WeakMap<object, any>();
            if (driver.kind === "postgres") {
                const release = driver.manager.releaseTransaction.bind(driver.manager);
                jest.spyOn(driver.manager, "releaseTransaction").mockImplementation((transaction: any, ...args: any[]) =>
                    // Per-transaction managers key physical pool disposal by the
                    // original reserved function, not our callable observation proxy.
                    release(nativeTransactions.get(transaction) ?? transaction, ...args));
            }
            jest.spyOn(driver.manager, "beginTransaction").mockImplementation(async (...args: any[]) => {
                const context = await begin(...args);
                const transaction = context.transaction;
                // A max-one pool can return the very same client more than once
                // in one case. Re-spying its spy would recursively call itself.
                const existing = observed.get(transaction);
                if (existing) {
                    context.transaction = existing;
                    return context;
                }
                for (const method of driver.kind === "postgres" ? ["unsafe"] : driver.kind === "mysql2" ? ["query", "execute"] : ["query"]) {
                    const native = context.transaction[method].bind(context.transaction);
                    jest.spyOn(context.transaction, method).mockImplementation((...params: any[]) => {
                        dispatches(method, ...params);
                        return native(...params);
                    });
                }
                if (driver.kind === "postgres") {
                    // unsafe spies cannot see the native callable/tag entry.
                    // Keep the real reserved SQL function and observe that entry
                    // too, before the managed facade gets a chance to wrap it.
                    context.transaction = new Proxy(context.transaction, {
                        apply(target, receiver, params) {
                            dispatches("tag", ...params);
                            return Reflect.apply(target, receiver, params);
                        },
                    });
                    nativeTransactions.set(context.transaction, transaction);
                }
                observed.set(transaction, context.transaction);
                observed.set(context.transaction, context.transaction);
                return context;
            });
        });
        afterEach(async () => {
            jest.restoreAllMocks();
            // Assert before cleanup so accidental commits cannot be hidden.
            expect(driver.rows(await driver.outside(`SELECT id FROM ${table}`))).toEqual([]);
        });
        afterAll(async () => {
            for (const key of [datasource, named, other]) clearTransactionManager(key);
            try { await driver.outside(`DROP TABLE IF EXISTS ${table}`); }
            finally { await driver.close(); }
        });

        it("keeps ambient ctx unchanged, records no withTestConnection owner, and preserves service rollback", async () => {
            const plain = () => ambient();
            const awaitedService = async () => { await Promise.resolve(); return ambient(); };
            await test(async probe => {
                expect(ambient).toThrow("Transaction context not initialized");
                await fix(async db => {
                    expect(driver.manager.getCurrentTransaction()).toBeUndefined();
                    expect(plain).toThrow("Transaction context not initialized");
                    await expect(awaitedService()).rejects.toThrow("Transaction context not initialized");
                    await insert(db, 1);
                    await insert(db, 2);
                });
                expect(probe.records).toEqual([]);
                const service = probe.track(async () => {
                    await insert(ambient(), 3);
                    throw failure;
                });
                await expect(tx(service)).rejects.toBe(failure);
                expect(await fix(ids)).toEqual([1, 2]);
                expect(probe.records).toHaveLength(1);
                expect(probe.records[0].outcome).toBe("rolled-back");
                expect(ambient).toThrow("Transaction context not initialized");
                await expect(awaitedService()).rejects.toThrow("Transaction context not initialized");
            });
        });

        it("uses one savepoint per call and does not resolve before real RELEASE completes", async () => {
            const releaseEntered = deferred();
            const finishRelease = deferred();
            const release = driver.manager.releaseSavepoint.bind(driver.manager);
            jest.spyOn(driver.manager, "releaseSavepoint").mockImplementation(async (...args: any[]) => {
                await release(...args);
                releaseEntered.resolve();
                await finishRelease.promise;
            });
            await test(async () => {
                let settled = false;
                const operation = fix(async db => {
                    await insert(db, 1);
                    return query(db, "SELECT 7 AS n");
                }).then(value => { settled = true; return value; });
                try {
                    await releaseEntered.promise;
                    expect(settled).toBe(false);
                } finally { finishRelease.resolve(); }
                expect(Number(driver.rows(await operation)[0].n)).toBe(7);
                const statements = dispatches.mock.calls.map(call => String(call[1]));
                expect(statements.filter(sql => /^SAVEPOINT /i.test(sql))).toHaveLength(1);
                expect(statements.filter(sql => /^RELEASE SAVEPOINT /i.test(sql))).toHaveLength(1);
            });
        });

        it("supports explicit symbol and named datasources and directly returned native results", async () => {
            await test(async () => {
                const result = await withTestConnection((db: any) => query(db, "SELECT 7 AS n"), { datasource: named });
                expect(Number(driver.rows(result)[0].n)).toBe(7);
                if (driver.kind === "mysql2") {
                    const [rows, fields] = await fix(db => db.execute("SELECT ? AS n", [8]));
                    expect(Number(rows[0].n)).toBe(8);
                    expect(fields[0].name).toBe("n");
                } else if (driver.kind === "postgres") {
                    const rows = await fix(db => db`SELECT ${8}::integer AS n`);
                    expect(Number(rows[0].n)).toBe(8);
                }
            });
        });

        it("defaults withTestConnection to the live named session datasource", async () => {
            await withTestTransaction(async () => {
                await withTestConnection(async db => {
                    await insert(db, 1);
                    expect(await ids(db)).toEqual([1]);
                });
                expect(await withTestConnection(ids)).toEqual([1]);
            }, { datasource: named });
        });

        it("rejects config objects, including inherited callbacks and accessors, before native entry", async () => {
            await test(() => fix(async db => {
                const callback = jest.fn();
                const getter = jest.fn(() => callback);
                const field = driver.kind === "mysql2" ? "sql" : "text";
                const inherited = Object.assign(Object.create({ callback }), { [field]: "SELECT 1" });
                const accessor = { [field]: "SELECT 1" };
                Object.defineProperty(accessor, "callback", { get: getter });
                const inheritedText = Object.create({ [field]: "SELECT 1", callback });
                const textGetter = jest.fn(() => "SELECT 1");
                const accessorText = Object.defineProperty({}, field, { get: textGetter });
                const methods = driver.kind === "postgres" ? ["unsafe"] : driver.kind === "mysql2" ? ["query", "execute"] : ["query"];
                for (const method of methods) {
                    for (const config of [{ [field]: "SELECT 1" }, inherited, accessor, inheritedText, accessorText]) {
                        const before = dispatches.mock.calls.length;
                        await expect(Promise.resolve().then(() => db[method](config))).rejects.toThrow();
                        expect(dispatches).toHaveBeenCalledTimes(before);
                    }
                    for (const args of [["SELECT 1", callback], ["SELECT 1", [], callback], ["SELECT 1", { callback }]]) {
                        const before = dispatches.mock.calls.length;
                        await expect(Promise.resolve().then(() => db[method](...args))).rejects.toThrow();
                        expect(dispatches).toHaveBeenCalledTimes(before);
                    }
                }
                expect(callback).not.toHaveBeenCalled();
                expect(getter).not.toHaveBeenCalled();
                expect(textGetter).not.toHaveBeenCalled();
                expect(Number(driver.rows(await query(db, "SELECT 9 AS n"))[0].n)).toBe(9);
            }));
        });

        it("exposes no native internals, callbacks, lifecycle or streaming APIs", async () => {
            await test(() => fix(async db => {
                const before = dispatches.mock.calls.length;
                const hidden = driver.kind === "postgres"
                    ? ["reserve", "begin", "end", "release", "file", "batch", "notify", "listen", "subscribe", "json", "array", "typed", "types", "options"]
                    : driver.kind === "mysql2"
                        ? ["connection", "pool", "prepare", "queryStream", "beginTransaction", "commit", "rollback", "release", "destroy", "on"]
                        : ["connection", "_queryable", "release", "end", "on", "copyFrom", "copyTo"];
                for (const key of hidden) expect(db[key]).toBeUndefined();
                if (driver.kind === "pg") {
                    const submit = jest.fn();
                    await expect(Promise.resolve().then(() => db.query({ submit }))).rejects.toThrow();
                    expect(submit).not.toHaveBeenCalled();
                }
                if (driver.kind === "postgres") {
                    await expect(Promise.resolve().then(() => db("identifier"))).rejects.toThrow();
                    await expect(Promise.resolve().then(() => db.unsafe("SELECT 1", [], { simple: true }))).rejects.toThrow();
                }
                expect(dispatches).toHaveBeenCalledTimes(before);
            }));
        });

        it("returns eager plain postgres promises without native query modifiers", async () => {
            if (driver.kind !== "postgres") return;
            await test(() => fix(async db => {
                for (const operation of [db`SELECT ${7}::integer AS n`, db.unsafe("SELECT 8 AS n")]) {
                    expect(operation).toBeInstanceOf(Promise);
                    for (const key of ["execute", "values", "raw", "describe", "cursor", "forEach", "stream", "readable", "writable", "simple", "cancel", "handle"]) {
                        expect(operation[key]).toBeUndefined();
                    }
                    expect(driver.rows(await operation)).toHaveLength(1);
                }
            }));
        });

        it("revokes escaped facades and extracted methods, including handles hidden in ordinary data", async () => {
            let escaped: any;
            let extracted: any[];
            let callTag: (() => unknown) | undefined;
            let data: any;
            const assertRevoked = async (finished = false) => {
                const expected = finished ? TransactionClosedError : "The connection was used after its withTestConnection callback finished";
                const before = dispatches.mock.calls.length;
                await expect(Promise.resolve().then(() => query(escaped, "SELECT 1"))).rejects.toThrow(expected);
                for (const method of extracted) {
                    await expect(Promise.resolve().then(() => method("SELECT 1"))).rejects.toThrow(expected);
                }
                if (callTag) await expect(Promise.resolve().then(callTag)).rejects.toThrow(expected);
                expect(dispatches).toHaveBeenCalledTimes(before);
            };
            await test(async () => {
                data = await fix(db => {
                    escaped = db;
                    extracted = (driver.kind === "postgres" ? ["unsafe"] : driver.kind === "mysql2" ? ["query", "execute"] : ["query"])
                        .map(method => db[method]);
                    if (driver.kind === "postgres") callTag = () => db`SELECT 1`;
                    // No deep scan: getters, maps and closures may retain revoked
                    // handles without making otherwise ordinary returned data fail.
                    return { get handle() { return db; }, map: new Map([["handle", db]]), read: () => db };
                });
                expect(data.read()).toBe(escaped);
                expect(data.handle).toBe(escaped);
                expect(data.map.get("handle")).toBe(escaped);
                await assertRevoked();
                await fix(db => query(db, "SELECT 1"));
            });
            await assertRevoked(true);
        });

        it("blocks all seven propagations on every datasource before callback execution", async () => {
            const propagations = [Propagation.REQUIRED, Propagation.REQUIRES_NEW, Propagation.NESTED,
                Propagation.SUPPORTS, Propagation.NOT_SUPPORTED, Propagation.MANDATORY, Propagation.NEVER];
            await test(() => fix(async () => {
                for (const propagation of propagations) {
                    for (const selected of [datasource, other]) {
                        const callback = jest.fn();
                        await expect(tx(callback, { propagation, datasource: selected })).rejects.toThrow("A transaction cannot start inside a withTestConnection callback");
                        expect(callback).not.toHaveBeenCalled();
                    }
                }
                const body = jest.fn();
                class Service {
                    @Transactional({ datasource: other, propagation: Propagation.SUPPORTS })
                    async run() { body(); }
                }
                await expect(new Service().run()).rejects.toThrow("A transaction cannot start inside a withTestConnection callback");
                expect(body).not.toHaveBeenCalled();
            }));
        });

        it("forbids recursive withTestConnection, managed callbacks and every hook provenance", async () => {
            await test(async () => {
                const body = jest.fn();
                await fix(async () => {
                    await expect(fix(body)).rejects.toThrow("withTestConnection was called inside another connection callback, a transaction callback or a transaction hook");
                    await expect(withTestConnection(body, { datasource: other })).rejects.toThrow("withTestConnection requires an active withTestTransaction callback");
                });
                for (const propagation of [Propagation.REQUIRED, Propagation.SUPPORTS, Propagation.NOT_SUPPORTED, Propagation.NEVER]) {
                    await tx(async () => { await expect(fix(body)).rejects.toThrow("withTestConnection was called inside another connection callback, a transaction callback or a transaction hook"); }, { propagation });
                }
                let hookCalls = 0;
                const hookResults: PromiseSettledResult<unknown>[] = [];
                const resume = deferred();
                let retained!: Promise<PromiseSettledResult<unknown>[]>;
                const hook = async () => {
                    hookCalls++;
                    const [result] = await Promise.allSettled([fix(body)]);
                    hookResults.push(result);
                };
                await tx(async () => { afterCommit(hook, datasource); });
                await expect(tx(async () => {
                    afterRollback(async () => {
                        await hook();
                        retained = resume.promise.then(() => Promise.allSettled([fix(body)]));
                    }, datasource);
                    throw failure;
                })).rejects.toBe(failure);
                expect(hookCalls).toBe(2);
                expect(driver.manager.getCurrentTransaction()).toBeUndefined();
                await fix(() => 1); // A fresh withTestConnection proves the owner overlap gate has closed.
                resume.resolve();
                const [retainedResult] = await retained;
                expect(retainedResult).toMatchObject({
                    status: "rejected", reason: { message: "withTestConnection was called inside another connection callback, a transaction callback or a transaction hook" },
                });
                await afterCommit(hook, datasource); // immediate ownerless branch
                expect(hookCalls).toBe(3);
                expect(hookResults).toHaveLength(3);
                for (const result of hookResults) {
                    expect(result).toMatchObject({
                        status: "rejected", reason: { message: "withTestConnection was called inside another connection callback, a transaction callback or a transaction hook" },
                    });
                }
                expect(body).not.toHaveBeenCalled();
            });
        });

        it("acquires the withTestConnection gate synchronously before its first await", async () => {
            await test(async () => {
                const finish = deferred();
                const first = fix(async db => { await finish.promise; await query(db, "SELECT 1"); });
                const ownerBody = jest.fn();
                const connectionBody = jest.fn();
                try {
                    await expect(tx(ownerBody)).rejects.toThrow("A transaction overlaps an active withTestConnection callback");
                    await expect(fix(connectionBody)).rejects.toThrow("withTestConnection overlaps another connection callback or transaction");
                    expect(ownerBody).not.toHaveBeenCalled();
                    expect(connectionBody).not.toHaveBeenCalled();
                } finally { finish.resolve(); await first; }
            });
        });

        it("rejects owner-to-withTestConnection overlap and withTestConnection-to-owner overlap with real SQL in flight", async () => {
            await test(async () => {
                for (const ownerFirst of [false, true]) {
                    const started = deferred();
                    const finish = deferred();
                    const active = async (db: any) => {
                        const pending = slow(db);
                        started.resolve();
                        await pending;
                        await finish.promise;
                    };
                    const first = ownerFirst ? tx(() => active(ambient())) : fix(active);
                    const body = jest.fn();
                    try {
                        await started.promise;
                        await expect(ownerFirst ? fix(body) : tx(body)).rejects.toThrow(ownerFirst
                            ? "withTestConnection overlaps another connection callback or transaction"
                            : "A transaction overlaps an active withTestConnection callback");
                        expect(body).not.toHaveBeenCalled();
                    } finally { finish.resolve(); await first; }
                }
                await fix(db => query(db, "SELECT 1"));
            });
        });

        it("fails on pending queries at callback completion and waits for them without scanning returned data", async () => {
            await test(async () => {
                let settled = false;
                let pending!: Promise<any>;
                const rollback = driver.manager.rollbackToSavepoint.bind(driver.manager);
                jest.spyOn(driver.manager, "rollbackToSavepoint").mockImplementation(async (...args: any[]) => {
                    expect(settled).toBe(true);
                    await rollback(...args);
                });
                await expect(fix(db => {
                    pending = slow(db).finally(() => { settled = true; });
                    return { pending }; // eager operation, not a deep-result policy
                })).rejects.toThrow(/pending|unawaited|await|query/i);
                expect(settled).toBe(true);
                await pending;
                await fix(db => insert(db, 1));
            });
        });

        it("retains independent callback and unawaited native query errors", async () => {
            await test(async () => {
                await fix(db => insert(db, 1));
                let native: unknown;
                const error = await rejected(fix(db => {
                    void insert(db, 1).catch(error => { native = error; });
                    throw failure;
                }));
                driver.nativeError(native);
                expect(errors(error)).toContain(failure);
                expect(errors(error)).toContain(native);
                expect(await fix(ids)).toEqual([1]);
            });
        });

        it("preserves the original native duplicate error and recovers before the next withTestConnection", async () => {
            await test(async () => {
                await fix(db => insert(db, 1));
                let native: unknown;
                const error = await rejected(fix(async db => {
                    try { await insert(db, 1); } catch (error) { native = error; throw error; }
                }));
                driver.nativeError(error);
                expect(error).toBe(native);
                expect(await fix(ids)).toEqual([1]);
                await tx(() => insert(ambient(), 2));
                expect(await fix(ids)).toEqual([1, 2]);
                const sql = dispatches.mock.calls.map(call => String(call[1]));
                expect(sql.some(text => /^ROLLBACK TO SAVEPOINT /i.test(text))).toBe(true);
                expect(sql.some(text => /^RELEASE SAVEPOINT /i.test(text))).toBe(true);
            });
        });

        it.each(["rollbackToSavepoint", "releaseSavepoint"])("poisons the session on recovery %s failure AFTER real SQL", async method => {
            const recovery = new Error(`injected ${method} failure after SQL`);
            let native: unknown;
            let connectionError: unknown;
            const exitError = await rejected(test(async () => {
                await fix(db => insert(db, 1));
                const original = driver.manager[method].bind(driver.manager);
                let injected = false;
                jest.spyOn(driver.manager, method).mockImplementation(async (...args: any[]) => {
                    await original(...args);
                    if (!injected) { injected = true; throw recovery; }
                });
                connectionError = await rejected(fix(async db => {
                    try { await insert(db, 1); } catch (error) { native = error; throw error; }
                }));
                driver.nativeError(native);
                expect(errors(connectionError)).toContain(native);
                expect(errors(connectionError)).toContain(recovery);
                const body = jest.fn();
                await expect(fix(body)).rejects.toThrow();
                expect(body).not.toHaveBeenCalled();
                // Catching both errors cannot turn final session exit into success.
            }));
            expect(errors(exitError)).toContain(native);
            expect(errors(exitError)).toContain(recovery);
        });

        it.each([false, true])("does not wait for a gated withTestConnection callback at root exit (body failure: %s)", async bodyFails => {
            const started = deferred();
            const finish = deferred();
            const bodyError = new Error("test body failed with a pending connection callback");
            let resumed = false;
            let pending!: Promise<unknown>;
            const rollback = driver.manager.rollbackTransaction.bind(driver.manager);
            const rollbackSpy = jest.spyOn(driver.manager, "rollbackTransaction").mockImplementation(async (...args: any[]) => {
                try { expect(resumed).toBe(false); }
                finally { await rollback(...args); }
            });
            const operation = test(async () => {
                pending = fix(async db => {
                    await insert(db, 1);
                    started.resolve();
                    await finish.promise;
                    resumed = true;
                    return insert(db, 2);
                });
                // This test deliberately ignores a caller until after root exit.
                // Observe its expected rejection immediately, not in the runtime.
                void pending.catch(() => { started.resolve(); });
                await started.promise;
                if (bodyFails) throw bodyError;
            });
            try {
                if (bodyFails) expect(errors(await rejected(operation))).toContain(bodyError);
                else await operation;
                expect(resumed).toBe(false);
                expect(rollbackSpy).toHaveBeenCalledTimes(1);
                rollbackSpy.mockRestore();
                expect(driver.rows(await driver.outside(`SELECT id FROM ${table}`))).toEqual([]);
                const before = dispatches.mock.calls.length;
                finish.resolve();
                await expect(pending).rejects.toThrow();
                expect(dispatches).toHaveBeenCalledTimes(before);
                await test(async () => {
                    expect(await fix(ids)).toEqual([]);
                    await fix(db => insert(db, 3));
                });
            } finally {
                finish.resolve();
                await Promise.allSettled([operation, pending]);
            }
        });

        it.each([false, true])("closes a forgotten managed caller before the next max-one-pool test (body failure: %s)", async bodyFails => {
            const started = deferred();
            const finish = deferred();
            const bodyError = new Error("test body failed with a forgotten managed caller");
            let pending!: Promise<unknown>;
            let cached: any;
            let late!: (() => unknown)[];
            let detached!: () => Promise<unknown>;
            let resumed = false;
            const operation = test(async () => {
                pending = tx(async () => {
                    cached = ambient();
                    late = lateOperations(cached);
                    detached = () => insert(cached, 5);
                    await insert(cached, 1);
                    started.resolve();
                    await finish.promise;
                    resumed = true;
                    // Both the inherited async context and pre-captured methods
                    // must reject, even while a new session owns the same pool.
                    await assertClosed([() => insert(ambient(), 2), ...late]);
                    return insert(cached, 3);
                });
                void pending.catch(() => { started.resolve(); });
                await started.promise;
                if (bodyFails) throw bodyError;
            });
            try {
                if (bodyFails) expect(errors(await rejected(operation))).toContain(bodyError);
                else await operation;
                expect(resumed).toBe(false);
                expect(ambient).toThrow("Transaction context not initialized");
                await assertClosed([detached]);
                expect(driver.rows(await driver.outside(`SELECT id FROM ${table}`))).toEqual([]);
                await test(async () => {
                    expect(await fix(ids)).toEqual([]);
                    const before = dispatches.mock.calls.length;
                    finish.resolve();
                    await expect(pending).rejects.toBeInstanceOf(TransactionClosedError);
                    expect(dispatches).toHaveBeenCalledTimes(before);
                    await tx(() => insert(ambient(), 4));
                    expect(await fix(ids)).toEqual([4]);
                });
            } finally {
                finish.resolve();
                await Promise.allSettled([operation, pending]);
            }
        });

        it("lets a detached production task start its own transaction after its parent commits", async () => {
            const start = deferred();
            let background!: Promise<unknown>;
            let parent: any;
            try {
                await tx(async () => {
                    parent = ambient();
                    await insert(parent, 1);
                    background = start.promise.then(() => tx(async () => {
                        expect(ambient()).not.toBe(parent);
                        await insert(ambient(), 2);
                    }));
                    void background.catch(() => {});
                });
                start.resolve();
                await background;
                expect(driver.rows(await driver.outside(`SELECT id FROM ${table} ORDER BY id`)).map(row => Number(row.id)))
                    .toEqual([1, 2]);
            } finally {
                start.resolve();
                await Promise.allSettled([background]);
                await driver.outside(`DELETE FROM ${table}`);
            }
        });

        it("lets a production interval started inside a transaction open a new transaction on each tick", async () => {
            const start = deferred();
            let timer: ReturnType<typeof setInterval> | undefined;
            const ticks: Promise<unknown>[] = [];
            let scheduled = 0;
            let resolveScheduled!: () => void;
            const scheduledAll = new Promise<void>(resolve => { resolveScheduled = resolve; });
            try {
                await tx(async () => {
                    await insert(ambient(), 1);
                    timer = setInterval(() => {
                        const id = ++scheduled + 1;
                        const tick = start.promise.then(() => tx(() => insert(ambient(), id)));
                        void tick.catch(() => {});
                        ticks.push(tick);
                        if (scheduled === 3) {
                            clearInterval(timer);
                            resolveScheduled();
                        }
                    }, 5);
                });
                start.resolve();
                await scheduledAll;
                await Promise.all(ticks);
                expect(driver.rows(await driver.outside(`SELECT id FROM ${table} ORDER BY id`)).map(row => Number(row.id)))
                    .toEqual([1, 2, 3, 4]);
            } finally {
                clearInterval(timer);
                start.resolve();
                await Promise.allSettled(ticks);
                await driver.outside(`DELETE FROM ${table}`);
            }
        });

        it("lets a background task open a new transaction while its test is live but rejects it after test exit", async () => {
            const start = deferred();
            let background!: Promise<unknown>;
            let repeat!: () => Promise<unknown>;
            try {
                await test(async () => {
                    await tx(async () => {
                        const parent = ambient();
                        await insert(parent, 1);
                        repeat = AsyncResource.bind(() => tx(async () => {
                            expect(ambient()).not.toBe(parent);
                            await insert(ambient(), 2);
                        }));
                        background = start.promise.then(repeat);
                        void background.catch(() => {});
                    });
                    start.resolve();
                    await background;
                    expect(await fix(ids)).toEqual([1, 2]);
                });
                await assertClosed([repeat]);
                expect(driver.rows(await driver.outside(`SELECT id FROM ${table}`))).toEqual([]);
                await test(() => fix(async db => { expect(await ids(db)).toEqual([]); }));
            } finally {
                start.resolve();
                await Promise.allSettled([background]);
            }
        });

        it.each(["commit", "rollback"])("revokes production ctx, bound methods and valueOf after %s, including during connection reuse", async outcome => {
            let cached: any;
            let late!: (() => unknown)[];
            let lookup!: () => any;
            let detached!: () => Promise<unknown>;
            const operation = tx(async () => {
                cached = ambient();
                late = lateOperations(cached);
                lookup = AsyncResource.bind(ambient);
                // A plain closure does not restore any transaction async context.
                detached = () => insert(cached, 5);
                await query(cached, "SELECT 1 AS n");
                if (outcome === "rollback") throw failure;
            });
            if (outcome === "rollback") await expect(operation).rejects.toBe(failure);
            else await operation;
            expect(ambient).toThrow("Transaction context not initialized");
            await assertClosed([lookup, () => insert(lookup(), 6), detached, ...late]);
            // Real COMMIT/ROLLBACK returned the physical checkout cleanly.
            await tx(async () => {
                expect(ambient()).not.toBe(cached);
                expect(driver.rows(await query(ambient(), "SELECT 7 AS n"))).toHaveLength(1);
                await assertClosed([lookup, detached, ...late]);
                expect(await ids(ambient())).toEqual([]);
            });
        });

        it("queues physical rollback behind an already-dispatched slow insert without waiting for its caller", async () => {
            const started = deferred();
            const finish = deferred();
            let pending!: Promise<unknown>;
            let nativeInsert!: Promise<unknown>;
            let cached: any;
            let lookup!: () => any;
            let nativeSettled = false;
            let resumed = false;
            const rollback = driver.manager.rollbackTransaction.bind(driver.manager);
            const rollbackSpy = jest.spyOn(driver.manager, "rollbackTransaction").mockImplementation(async (...args: any[]) => {
                try {
                    // Rollback starts without waiting for queries or callbacks.
                    // The native connection serializes the SQL.
                    expect(nativeSettled).toBe(false);
                    expect(resumed).toBe(false);
                    expect(dispatches.mock.calls.some(call => /^INSERT INTO /i.test(String(call[1])) && /sleep/i.test(String(call[1])))).toBe(true);
                    // The gate closes before entering physical ROLLBACK, not
                    // merely after rollback/release has completed.
                    await assertClosed([lookup, () => insert(cached, 7)]);
                } finally { await rollback(...args); }
            });
            const operation = test(async () => {
                pending = tx(async () => {
                    cached = ambient();
                    lookup = AsyncResource.bind(ambient);
                    const sql = driver.kind === "mysql2"
                        ? `INSERT INTO ${table} (id) SELECT 1 + SLEEP(0.08)`
                        : `INSERT INTO ${table} (id) SELECT 1 FROM pg_sleep(0.08)`;
                    // Calling then starts lazy postgres queries before callback
                    // exit, as well as observing the eager pg/mysql promises.
                    nativeInsert = query(cached, sql).then(result => {
                        nativeSettled = true;
                        return result;
                    });
                    void nativeInsert.catch(() => {});
                    started.resolve();
                    await nativeInsert;
                    await finish.promise;
                    resumed = true;
                    return insert(cached, 2);
                });
                void pending.catch(() => { started.resolve(); });
                await started.promise;
            });
            try {
                await operation;
                await nativeInsert;
                expect(nativeSettled).toBe(true);
                expect(resumed).toBe(false);
                expect(rollbackSpy).toHaveBeenCalledTimes(1);
                expect(driver.rows(await driver.outside(`SELECT id FROM ${table}`))).toEqual([]);
                const before = dispatches.mock.calls.length;
                finish.resolve();
                await expect(pending).rejects.toBeInstanceOf(TransactionClosedError);
                expect(dispatches).toHaveBeenCalledTimes(before);
                rollbackSpy.mockRestore();
                await test(() => fix(async db => { expect(await ids(db)).toEqual([]); }));
            } finally {
                finish.resolve();
                await Promise.allSettled([operation, pending, nativeInsert]);
            }
        });

        it("shares joined and NESTED handles until owner completion but closes each REQUIRES_NEW scope independently", async () => {
            let parent: any;
            let parentLate!: (() => unknown)[];
            await test(async () => {
                await tx(async () => {
                    parent = ambient();
                    parentLate = lateOperations(parent);
                    expect(ambient()).toBe(parent);
                    for (const propagation of [Propagation.REQUIRED, Propagation.NESTED]) {
                        let joined: any;
                        await tx(async () => {
                            joined = ambient();
                            expect(joined).toBe(parent);
                            await query(joined, "SELECT 1 AS n");
                        }, { propagation });
                        expect(ambient()).toBe(parent);
                        await query(joined, "SELECT 2 AS n");
                    }
                    for (const fails of [false, true]) {
                        let child: any;
                        let childLate!: (() => unknown)[];
                        const operation = tx(async () => {
                            child = ambient();
                            expect(child).not.toBe(parent);
                            childLate = lateOperations(child);
                            await query(child, "SELECT 3 AS n");
                            if (fails) throw failure;
                        }, { propagation: Propagation.REQUIRES_NEW });
                        if (fails) await expect(operation).rejects.toBe(failure);
                        else await operation;
                        await assertClosed(childLate);
                        expect(ambient()).toBe(parent);
                        await query(parent, "SELECT 4 AS n");
                    }
                });
                await assertClosed(parentLate);
                expect(await fix(ids)).toEqual([]);
                await tx(async () => {
                    expect(ambient()).not.toBe(parent);
                    await query(ambient(), "SELECT 5 AS n");
                });
            });
            await assertClosed(parentLate);
            expect(driver.rows(await driver.outside(`SELECT id FROM ${table}`))).toEqual([]);
            const savepoints = dispatches.mock.calls.map(call => String(call[1])).filter(sql => /^SAVEPOINT /i.test(sql));
            expect(savepoints.length).toBeGreaterThan(0);
            expect(new Set(savepoints).size).toBe(savepoints.length);
        });

        it("closes every still-active parent and REQUIRES_NEW handle at root exit", async () => {
            const started = deferred();
            const finish = deferred();
            let pending!: Promise<unknown>;
            const late: (() => unknown)[] = [];
            const operation = test(async () => {
                pending = tx(async () => {
                    const parent = ambient();
                    late.push(...lateOperations(parent), AsyncResource.bind(ambient));
                    await tx(async () => {
                        const child = ambient();
                        expect(child).not.toBe(parent);
                        late.push(...lateOperations(child), AsyncResource.bind(ambient));
                        started.resolve();
                        await finish.promise;
                        return insert(child, 1);
                    }, { propagation: Propagation.REQUIRES_NEW });
                });
                void pending.catch(() => { started.resolve(); });
                await started.promise;
            });
            try {
                await operation;
                await assertClosed(late);
                const before = dispatches.mock.calls.length;
                finish.resolve();
                await expect(pending).rejects.toBeInstanceOf(TransactionClosedError);
                // Late owner cleanup must not send RELEASE/ROLLBACK TO SAVEPOINT
                // after physical root rollback has removed those savepoints.
                expect(dispatches).toHaveBeenCalledTimes(before);
                await test(() => fix(async db => { expect(await ids(db)).toEqual([]); }));
            } finally {
                finish.resolve();
                await Promise.allSettled([operation, pending]);
            }
        });

        it("rejects outside, mock and bound closed sessions before callback execution", async () => {
            const body = jest.fn();
            await expect(fix(body)).rejects.toThrow("withTestConnection requires an active withTestTransaction callback");
            await mockTransactions(async () => {
                await expect(fix(body)).rejects.toThrow(/mockTransactions|mock/i);
            }, { datasource });
            let closed!: () => Promise<unknown>;
            await test(async () => { closed = AsyncResource.bind(() => fix(body)); });
            await expect(closed()).rejects.toBeInstanceOf(TransactionClosedError);
            expect(body).not.toHaveBeenCalled();
        });

        it("has no logical deadline, including after an expired managed owner", async () => {
            await test(async probe => {
                await expect(tx(async () => {
                    await new Promise(resolve => setTimeout(resolve, 35));
                }, { timeout: 10 })).rejects.toBeInstanceOf(TransactionTimeoutError);
                await fix(async db => {
                    expect(driver.manager.getCurrentTransaction()).toBeUndefined();
                    expect(driver.manager.checkDeadline()).toBeUndefined();
                    await slow(db);
                });
                expect(probe.records).toHaveLength(1);
            });
        });
    });
}
