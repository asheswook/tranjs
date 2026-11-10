import { afterCommit, clearTransactionManager, PlatformTransactionManager, transactional, useTransactionManager } from "../src";
import { fixture, mockTransactions, withTestTransaction } from "../../testing/src";

class FixtureManager extends PlatformTransactionManager<object> {
    constructor() { super(); }
    protected async beginTransaction() { return { transaction: {}, metadata: { driverName: "provenance" } }; }
    protected async commitTransaction() {}
    protected async rollbackTransaction() {}
    protected async createSavepoint() {}
    protected async rollbackToSavepoint() {}
    protected async releaseSavepoint() {}
    protected createFixtureConnection() { return Object.create(null); }
}

afterEach(() => clearTransactionManager());

it.each([false, true])("retains fixture denial through nested test sessions and immediate hooks (hook=%s)", async hook => {
    useTransactionManager(new FixtureManager());
    await withTestTransaction(async () => {
        await fixture(async () => {
            const nested = () => mockTransactions(async () => {
                let calls = 0;
                await expect(transactional(() => { calls++; })()).rejects.toThrow("forbidden inside a fixture callback");
                expect(calls).toBe(0);
            });
            if (hook) await afterCommit(nested);
            else await nested();
        });
    });
});
