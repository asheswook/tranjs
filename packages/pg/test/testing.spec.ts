import { DatabaseError, Pool } from "pg";
import {
    afterCommit, afterRollback, clearTransactionManager, IsolationLevel, Propagation,
    transactional, Transactional, TransactionTimeoutError, UnexpectedRollbackError,
    useTransactionManager,
} from "@tranjs/core";
import { withTestTransaction } from "@tranjs/testing";
import { ctx, PostgreSQLClientPerTransactionManager, PostgreSQLTransactionManager } from "../src";

const url = process.env.PG_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const failure = new Error("application failure");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

describe.each(["pool", "per-transaction"])("withTestTransaction / pg / %s (real database)", mode => {
    const pool = new Pool({ connectionString: url, max: 5 });
    const datasource = Symbol(`pg-testing-${mode}`);
    const table = `tranjs_pg_testing_${mode.replace(/-/g, "_")}`;
    const deferredTable = `${table}_deferred`;
    const immediateTable = `${table}_immediate`;
    const manager = mode === "pool"
        ? new PostgreSQLTransactionManager(pool)
        : new PostgreSQLClientPerTransactionManager({ connectionString: url });
    const tx = <T>(fn: () => T | Promise<T>, options: Parameters<typeof transactional>[1] = {}) =>
        transactional(fn, { ...options, datasource })();
    const test = <T>(fn: Parameters<typeof withTestTransaction<T>>[0]) =>
        withTestTransaction(fn, { datasource });
    const insert = async (id: number) => { await ctx(datasource).query(`INSERT INTO ${table} VALUES (${id})`); };
    const ids = async () => (await ctx(datasource).query(`SELECT id FROM ${table} ORDER BY id`)).rows.map(row => Number(row.id));
    const outsideIds = async () => (await pool.query(`SELECT id FROM ${table} ORDER BY id`)).rows.map(row => Number(row.id));
    const constraintInsert = async (id: number, fixture = deferredTable) => {
        await ctx(datasource).query(`INSERT INTO ${fixture} VALUES (${id})`);
    };
    const constraintIds = async (fixture = deferredTable) =>
        (await ctx(datasource).query(`SELECT id FROM ${fixture} ORDER BY id`)).rows.map(row => Number(row.id));
    const expectUniqueError = async (operation: Promise<unknown>) => {
        await expect(operation).rejects.toBeInstanceOf(DatabaseError);
        await expect(operation).rejects.toMatchObject({ code: "23505" });
    };

    beforeAll(async () => {
        await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (id integer PRIMARY KEY)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS ${deferredTable} (id integer UNIQUE DEFERRABLE INITIALLY DEFERRED)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS ${immediateTable} (id integer UNIQUE DEFERRABLE INITIALLY IMMEDIATE)`);
        useTransactionManager(manager, datasource);
    });
    beforeEach(async () => {
        for (const fixture of [table, deferredTable, immediateTable]) await pool.query(`DELETE FROM ${fixture}`);
    });
    afterEach(async () => {
        // Check before fixture cleanup: a leaked commit must fail the test.
        expect(await outsideIds()).toEqual([]);
        for (const fixture of [deferredTable, immediateTable]) {
            expect((await pool.query(`SELECT * FROM ${fixture}`)).rows).toEqual([]);
        }
        expect(pool.idleCount).toBe(pool.totalCount);
    });
    afterAll(async () => {
        clearTransactionManager(datasource);
        await pool.query(`DROP TABLE IF EXISTS ${table}`);
        await pool.query(`DROP TABLE IF EXISTS ${deferredTable}`);
        await pool.query(`DROP TABLE IF EXISTS ${immediateTable}`);
        await pool.end();
    });

    it("preserves decorated service atomicity, visibility and final rollback", async () => {
        class Service {
            @Transactional({ datasource })
            async save(fail: boolean) {
                await insert(1);
                await insert(2);
                if (fail) throw failure;
                return 42;
            }
        }
        await test(async t => {
            const service = t.track(new Service());
            await expect(service.save(true)).rejects.toBe(failure);
            expect(await tx(ids)).toEqual([]);
            expect(await service.save(false)).toBe(42);
            expect(await tx(ids)).toEqual([1, 2]);
            expect(await outsideIds()).toEqual([]);
        });
        expect(await outsideIds()).toEqual([]);
    });

    it("rolls back the physical test transaction even when the test callback throws", async () => {
        await expect(test(async () => {
            await tx(() => insert(1));
            throw failure;
        })).rejects.toBe(failure);
        expect(await outsideIds()).toEqual([]);
        // Also prove the manager/connection can be reused after failed cleanup scope.
        await test(() => tx(() => insert(2)));
    });

    it("keeps REQUIRED, REQUIRES_NEW and NESTED on the same connection with local rollback", async () => {
        await test(async () => {
            await tx(async () => {
                const connection = ctx(datasource);
                await insert(1);
                await tx(async () => {
                    expect(ctx(datasource)).toBe(connection);
                    await insert(2);
                });
                await expect(tx(async () => {
                    expect(ctx(datasource)).toBe(connection);
                    await insert(3);
                    throw failure;
                }, { propagation: Propagation.REQUIRES_NEW })).rejects.toBe(failure);
                expect(await ids()).toEqual([1, 2]);
                await tx(async () => {
                    expect(ctx(datasource)).toBe(connection);
                    expect(await ids()).toEqual([1, 2]);
                    await insert(4);
                }, { propagation: Propagation.REQUIRES_NEW });
                await expect(tx(async () => {
                    await insert(5);
                    throw failure;
                }, { propagation: Propagation.NESTED })).rejects.toBe(failure);
                await tx(() => insert(6), { propagation: Propagation.NESTED });
                expect(await ids()).toEqual([1, 2, 4, 6]);
            });
            // REQUIRES_NEW is a savepoint here, not an independent physical commit.
            await expect(tx(async () => {
                await insert(10);
                await tx(() => insert(11), { propagation: Propagation.REQUIRES_NEW });
                expect(await ids()).toEqual([1, 2, 4, 6, 10, 11]);
                throw failure;
            })).rejects.toBe(failure);
            expect(await tx(ids)).toEqual([1, 2, 4, 6]);
            // NESTED without an ambient owner must still create a logical owner.
            await tx(() => insert(12), { propagation: Propagation.NESTED });
        });
    });

    it("marks an owner rollback-only after a caught REQUIRED callback failure", async () => {
        await test(async () => {
            await expect(tx(async () => {
                await insert(1);
                await expect(tx(async () => {
                    await insert(2);
                    throw failure;
                })).rejects.toBe(failure);
            })).rejects.toBeInstanceOf(UnexpectedRollbackError);
            expect(await tx(ids)).toEqual([]);
            await tx(() => insert(3));
        });
    });

    it("runs logical commit/rollback hooks, without rerunning them for final cleanup", async () => {
        const events: string[] = [];
        await test(async () => {
            await tx(async () => {
                afterCommit(() => { events.push("commit"); }, datasource);
                afterRollback(() => { events.push("wrong rollback"); }, datasource);
                await insert(1);
            });
            expect(events).toEqual(["commit"]);
            await expect(tx(async () => {
                afterCommit(() => { events.push("wrong commit"); }, datasource);
                afterRollback(() => { events.push("rollback"); }, datasource);
                await insert(2);
                throw failure;
            })).rejects.toBe(failure);
            await tx(async () => {
                await tx(async () => {
                    afterCommit(() => { events.push("inner"); }, datasource);
                }, { propagation: Propagation.REQUIRES_NEW });
                expect(events).toEqual(["commit", "rollback", "inner"]);
                afterCommit(() => { events.push("outer"); }, datasource);
            });
        });
        expect(events).toEqual(["commit", "rollback", "inner", "outer"]);
    });

    it("uses an inner owner's own deadline and recovers the parent after timeout", async () => {
        await test(async () => {
            await tx(async () => {
                await insert(1);
                await expect(tx(async () => {
                    await insert(2);
                    await sleep(160);
                }, { propagation: Propagation.REQUIRES_NEW, timeout: 100 })).rejects.toBeInstanceOf(TransactionTimeoutError);
                expect(await ids()).toEqual([1]);
                await insert(3);
            });
            expect(await tx(ids)).toEqual([1, 3]);
        });
    });

    it("recovers an aborted savepoint when application code catches a PostgreSQL query error", async () => {
        const hooks: string[] = [];
        await test(async () => {
            // No application exception escapes the joined callback. RELEASE itself fails.
            await expect(tx(async () => {
                await insert(1);
                await tx(async () => {
                    await expect(insert(1)).rejects.toMatchObject({ code: "23505" });
                });
            })).rejects.toThrow(/aborted|savepoint|release|commit/i);
            expect(await tx(ids)).toEqual([]);
            await tx(async () => {
                await insert(2);
                await expect(tx(async () => {
                    afterCommit(() => { hooks.push("wrong commit"); }, datasource);
                    afterRollback(() => { hooks.push("rollback"); }, datasource);
                    await insert(3);
                    await expect(insert(3)).rejects.toMatchObject({ code: "23505" });
                }, { propagation: Propagation.REQUIRES_NEW })).rejects.toThrow(/aborted|savepoint|release|commit/i);
                expect(hooks).toEqual(["rollback"]);
                expect(await ids()).toEqual([2]);
                await insert(4);
            });
            expect(await tx(ids)).toEqual([2, 4]);
        });
    });

    it("rejects deferred duplicates at logical commit with the production native error", async () => {
        const duplicate = async () => {
            await constraintInsert(1);
            await constraintInsert(1);
            expect(await constraintIds()).toEqual([1, 1]);
        };
        // The same inserts succeed until physical COMMIT in production.
        await expectUniqueError(tx(duplicate));
        await test(async () => {
            await expectUniqueError(tx(duplicate));
            expect(await tx(() => constraintIds())).toEqual([]);
            await tx(() => constraintInsert(2));
            expect(await tx(() => constraintIds())).toEqual([2]);
        });
    });

    it.each([Propagation.REQUIRES_NEW, Propagation.NESTED])(
        "recovers deferred constraint failure in %s without rolling back the outer owner", async propagation => {
            await test(async () => {
                await tx(async () => {
                    await constraintInsert(1);
                    await expectUniqueError(tx(async () => {
                        await constraintInsert(2);
                        await constraintInsert(2);
                        expect(await constraintIds()).toEqual([1, 2, 2]);
                    }, { propagation }));
                    expect(await constraintIds()).toEqual([1]);
                    await constraintInsert(3);
                });
                expect(await tx(() => constraintIds())).toEqual([1, 3]);
            });
        },
    );

    it.each([Propagation.REQUIRES_NEW, Propagation.NESTED])(
        "restores initially deferred mode after a successful %s check", async propagation => {
            await test(() => tx(async () => {
                await tx(() => constraintInsert(1), { propagation });
                await tx(async () => {
                    // A duplicate must still be allowed until this scope completes.
                    await constraintInsert(1);
                    expect(await constraintIds()).toEqual([1, 1]);
                    await ctx(datasource).query(`DELETE FROM ${deferredTable} WHERE id = 1`);
                    await constraintInsert(2);
                }, { propagation });
                expect(await constraintIds()).toEqual([2]);
            }));
        },
    );

    it.each([
        [Propagation.REQUIRES_NEW, false], [Propagation.NESTED, false],
        [Propagation.REQUIRES_NEW, true], [Propagation.NESTED, true],
    ] as const)("preserves immediate mode after %s (application override: %s)", async (propagation, explicit) => {
        const fixture = explicit ? deferredTable : immediateTable;
        await test(() => tx(async () => {
            if (explicit) await ctx(datasource).query("SET CONSTRAINTS ALL IMMEDIATE");
            await tx(() => constraintInsert(1, fixture), { propagation });
            let duplicateInserted = false;
            await expectUniqueError(tx(async () => {
                await constraintInsert(1, fixture);
                duplicateInserted = true;
            }, { propagation }));
            expect(duplicateInserted).toBe(false);
            expect(await constraintIds(fixture)).toEqual([1]);
        }));
    });

    it("recovers a native query error escaping an inner owner", async () => {
        await test(() => tx(async () => {
            await insert(1);
            await expect(tx(async () => {
                await insert(2);
                await insert(2);
            }, { propagation: Propagation.REQUIRES_NEW })).rejects.toBeDefined();
            expect(await ids()).toEqual([1]);
            await insert(3);
        }));
    });

    it("preserves cross-owner NESTED savepoints (including MySQL's name-replacement case)", async () => {
        await test(() => tx(async () => {
            await expect(tx(async () => {
                await insert(1);
                await tx(() => tx(() => insert(2), { propagation: Propagation.NESTED }), {
                    propagation: Propagation.REQUIRES_NEW,
                });
                throw failure;
            }, { propagation: Propagation.NESTED })).rejects.toBe(failure);
            expect(await ids()).toEqual([]);
            await insert(3);
        }));
    });

    it("records tracked owner metadata while treating requested options as descriptive", async () => {
        await test(async t => {
            const inner = t.track(() => insert(2));
            const outer = t.track(async () => {
                await insert(1);
                await tx(inner, {
                    propagation: Propagation.REQUIRES_NEW,
                    isolationLevel: IsolationLevel.SERIALIZABLE,
                    readOnly: true,
                });
            });
            const rolledBack = t.track(async () => {
                await insert(3);
                throw failure;
            });
            await tx(outer);
            await expect(tx(rolledBack)).rejects.toBe(failure);
            const outerInfo = t.txOf(outer);
            const innerInfo = t.txOf(inner);
            const rollbackInfo = t.txOf(rolledBack);
            expect(outerInfo).toBeDefined();
            expect(innerInfo).toBeDefined();
            expect(rollbackInfo).toBeDefined();
            expect(outerInfo?.outcome).toBe("committed");
            expect(innerInfo?.outcome).toBe("committed");
            expect(rollbackInfo?.outcome).toBe("rolled-back");
            expect(innerInfo?.id).not.toBe(outerInfo?.id);
            expect(innerInfo?.parent).toBeDefined();
            expect(innerInfo?.propagation).toBe(Propagation.REQUIRES_NEW);
            expect(innerInfo?.options).toMatchObject({ isolationLevel: IsolationLevel.SERIALIZABLE, readOnly: true });
            // Applying READ ONLY physically would reject this insert. It is only recorded.
            expect(await tx(ids)).toEqual([1, 2]);
        });
    });

    it("injects commit failure into the owner containing a tracked joined function", async () => {
        const hooks: string[] = [];
        await test(async t => {
            const joined = t.track(async () => tx(() => insert(2)));
            t.fail("commit", { containing: joined });
            // A different owner completes first: containing must not mean "next commit".
            await tx(() => insert(90));
            await expect(tx(async () => {
                afterCommit(() => { hooks.push("wrong commit"); }, datasource);
                afterRollback(() => { hooks.push("rollback"); }, datasource);
                await insert(1);
                await joined();
            })).rejects.toThrow();
            expect(hooks).toEqual(["rollback"]);
            expect(await tx(ids)).toEqual([90]);
            // Injection is one-shot and must not poison later logical owners.
            await tx(() => insert(3));
            expect(await tx(ids)).toEqual([3, 90]);
        });
    });

    it.each([
        [Propagation.REQUIRES_NEW, Propagation.REQUIRES_NEW],
        [Propagation.REQUIRES_NEW, Propagation.NESTED],
        [Propagation.NESTED, Propagation.REQUIRES_NEW],
        [Propagation.NESTED, Propagation.NESTED],
    ])("rejects overlapping %s / %s branches without corrupting their parent", async (active, attempted) => {
        await test(() => tx(async () => {
            const started = deferred();
            const finish = deferred();
            const first = tx(async () => {
                await insert(1);
                started.resolve();
                await finish.promise;
            }, { propagation: active });
            try {
                await started.promise;
                const callback = jest.fn();
                await expect(tx(callback, { propagation: attempted })).rejects.toThrow(/overlap|concurr|parallel|sibling nested/i);
                expect(callback).not.toHaveBeenCalled();
            } finally {
                finish.resolve();
                await first;
            }
            expect(await ids()).toEqual([1]);
            await insert(2);
        }));
    });

    it("runs concurrent independent helpers on distinct physical connections", async () => {
        const bothReady = deferred();
        const connections: unknown[] = [];
        let ready = 0;
        await Promise.all([1, 2].map(id => test(() => tx(async () => {
            connections.push(manager.getCurrentTransaction());
            await insert(id);
            if (++ready === 2) bothReady.resolve();
            await bothReady.promise;
            expect(await ids()).toEqual([id]);
            expect(await outsideIds()).toEqual([]);
        }))));
        expect(connections).toHaveLength(2);
        expect(connections[0]).not.toBe(connections[1]);
        expect(await outsideIds()).toEqual([]);
    });
});
