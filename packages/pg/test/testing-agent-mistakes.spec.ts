import { Pool } from "pg";
import {
    afterCommit, clearTransactionManager, Propagation, runInTransaction,
    Transactional, useTransactionManager,
} from "@tranjs/core";
import { withTestTransaction } from "@tranjs/core/testing";
import { matchers } from "@tranjs/core/testing/jest";
import { ctx, PostgreSQLTransactionManager } from "../src";

expect.extend(matchers);

const datasource = Symbol("pg-agent-mistakes");
const pool = new Pool({
    connectionString: process.env.PG_URL ?? "postgres://postgres:postgres@localhost:5432/postgres",
    max: 5,
});
const table = "tranjs_pg_agent_mistakes";
const insert = async (id: string) => {
    await ctx(datasource).query(`INSERT INTO ${table} (id) VALUES ($1)`, [id]);
};
const outsideRows = async () => (await pool.query(`SELECT id FROM ${table} ORDER BY id`)).rows;
const assertNoLeaks = async () => { expect(await outsideRows()).toEqual([]); };
const isolated = (fn: Parameters<typeof withTestTransaction>[0]) => withTestTransaction(fn, { datasource });

class OrderRepository {
    async checkStock(_id: string) {}
    async save(id: string) { await insert(id); }
}

// Track the repository *inside* this boundary, not the decorated writer's entry.
class OrderWriter {
    constructor(protected readonly orders: OrderRepository) {}

    @Transactional({ datasource })
    async save(id: string) { await this.orders.save(id); }
}

class SeparateOrderWriter extends OrderWriter {
    @Transactional({ datasource, propagation: Propagation.REQUIRES_NEW })
    override async save(id: string) { await this.orders.save(id); }
}

class OrderService {
    constructor(
        protected readonly orders: OrderRepository,
        protected readonly mailer: { send(id: string): Promise<void> },
        protected readonly writer = new OrderWriter(orders),
    ) {}

    @Transactional({ datasource })
    async place(id: string) { await this.execute(id); }

    protected async execute(id: string) {
        await this.orders.checkStock(id);
        await this.saveOrder(id);
        await this.notify(id);
    }

    protected async saveOrder(id: string) { await this.writer.save(id); }
    protected async notify(id: string) { return afterCommit(() => this.mailer.send(id), datasource); }
}

class UndecoratedOrderService extends OrderService {
    override async place(id: string) { await this.execute(id); }
}

class ImmediateEmailOrderService extends OrderService {
    protected override async notify(id: string) { await this.mailer.send(id); }
}

class MissingAwaitOrderService extends OrderService {
    protected override async saveOrder(id: string) {
        // Deliberate agent mistake. The test retains the Promise only to drain it safely.
        void this.orders.save(id);
    }
}

function expectFailureFacts(assertion: () => void, facts: string[]) {
    let failure: unknown;
    try { assertion(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    for (const fact of facts) expect((failure as Error).message).toContain(fact);
}

describe("agent-mistake acceptance / real PostgreSQL", () => {
    beforeAll(async () => {
        await pool.query(`CREATE TABLE ${table} (id text PRIMARY KEY)`);
        useTransactionManager(new PostgreSQLTransactionManager(pool), datasource);
    });
    afterEach(async () => {
        try { await assertNoLeaks(); }
        finally { await pool.query(`DELETE FROM ${table}`); }
    });
    afterAll(async () => {
        clearTransactionManager(datasource);
        try { await pool.query(`DROP TABLE IF EXISTS ${table}`); }
        finally { await pool.end(); }
    });

    it("accepts the intended same-owner, committed, afterCommit policy", async () => {
        await isolated(async tx => {
            const orders = tx.track(new OrderRepository());
            const mailer = tx.track({ send: jest.fn(async (_id: string) => {}) });
            await new OrderService(orders, mailer).place("correct");
            expect(orders.checkStock).toRunInSameTransactionAs(orders.save);
            expect(orders.save).toHaveCommitted();
            expect(mailer.send).toRunOutsideTransaction();
            expect(mailer.send).toRunAfterCommitOf(orders.save);
        });
        await assertNoLeaks();
    });

    it("detects removed @Transactional: outside call versus committed REQUIRED owner", async () => {
        await isolated(async tx => {
            const orders = tx.track(new OrderRepository());
            const mailer = tx.track({ send: jest.fn(async (_id: string) => {}) });
            await new UndecoratedOrderService(orders, mailer).place("undecorated");
            expectFailureFacts(() => expect(orders.checkStock).toRunInSameTransactionAs(orders.save), [
                "toRunInSameTransactionAs", "outside transaction", "tx#", "REQUIRED", "committed",
            ]);
        });
    });

    it("detects REQUIRED changed to REQUIRES_NEW: different committed owners", async () => {
        await isolated(async tx => {
            const orders = tx.track(new OrderRepository());
            const mailer = tx.track({ send: jest.fn(async (_id: string) => {}) });
            await new OrderService(orders, mailer, new SeparateOrderWriter(orders)).place("separate");
            expect(tx.txOf(orders.checkStock)).not.toBe(tx.txOf(orders.save));
            expectFailureFacts(() => expect(orders.checkStock).toRunInSameTransactionAs(orders.save), [
                "toRunInSameTransactionAs", "tx#", "REQUIRED", "REQUIRES_NEW", "committed",
            ]);
        });
    });

    it("detects email inside the transaction instead of an afterCommit callback", async () => {
        await isolated(async tx => {
            const orders = tx.track(new OrderRepository());
            const mailer = tx.track({ send: jest.fn(async (_id: string) => {}) });
            await new ImmediateEmailOrderService(orders, mailer).place("early-email");
            expectFailureFacts(() => expect(mailer.send).toRunOutsideTransaction(), [
                "toRunOutsideTransaction", "tx#", "REQUIRED", "committed",
            ]);
            expectFailureFacts(() => expect(mailer.send).toRunAfterCommitOf(orders.save), [
                "toRunAfterCommitOf", "tx#", "REQUIRED", "committed",
            ]);
        });
    });

    it("limitation: missing await passes entry/outcome matchers while timer work escapes cleanup", async () => {
        let pending: Promise<void> | undefined;
        let completed = false;
        // Unbound fake timers use their invocation context, not their registration context.
        // This models a queued repository write without relying on timing races or raw SQL.
        jest.useFakeTimers({
            doNotFake: ["Date", "hrtime", "nextTick", "performance", "queueMicrotask", "setImmediate"],
        });
        try {
            await isolated(async tx => {
                const orders = tx.track({
                    checkStock: async (_id: string) => {},
                    save(id: string) {
                        pending = new Promise<void>((resolve, reject) => {
                            setTimeout(() => {
                                runInTransaction(() => insert(id), { datasource }).then(() => {
                                    completed = true;
                                    resolve();
                                }, reject);
                            }, 1);
                        });
                        return pending;
                    },
                });
                const mailer = tx.track({ send: jest.fn(async (_id: string) => {}) });
                await new MissingAwaitOrderService(orders, mailer).place("missing-await");
                expect(orders.checkStock).toRunInSameTransactionAs(orders.save);
                expect(orders.save).toHaveCommitted();
                expect(mailer.send).toRunAfterCommitOf(orders.save);
                expect(completed).toBe(false); // Owner already committed, but save is unfinished.
            });
            await assertNoLeaks(); // Too early to detect the still-queued work.
            await jest.advanceTimersByTimeAsync(1); // Outside the callback: opens a real transaction.
            await pending;
            expect(completed).toBe(true);
            expect(await outsideRows()).toEqual([{ id: "missing-await" }]);
            await expect(assertNoLeaks()).rejects.toThrow(); // Separate-pool leak check catches it.
        } finally {
            jest.useRealTimers();
            await pool.query(`DELETE FROM ${table}`);
        }
    });

    it("limitation: raw pool SQL in a tracked repo passes matchers and persists after cleanup", async () => {
        class RawPoolOrderRepository extends OrderRepository {
            override async save(id: string) {
                await pool.query(`INSERT INTO ${table} (id) VALUES ($1)`, [id]);
            }
        }
        try {
            await isolated(async tx => {
                const orders = tx.track(new RawPoolOrderRepository());
                const mailer = tx.track({ send: jest.fn(async (_id: string) => {}) });
                await new OrderService(orders, mailer).place("raw-pool");
                expect(orders.checkStock).toRunInSameTransactionAs(orders.save);
                expect(orders.save).toHaveCommitted();
                expect(mailer.send).toRunAfterCommitOf(orders.save);
            });
            expect(await outsideRows()).toEqual([{ id: "raw-pool" }]);
            await expect(assertNoLeaks()).rejects.toThrow();
        } finally { await pool.query(`DELETE FROM ${table}`); }
    });
});
