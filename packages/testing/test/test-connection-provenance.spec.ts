import { afterCommit, clearTransactionManager, PlatformTransactionManager, transactional, useTransactionManager } from "@tranjs/core";
import { withTestConnection, mockTransactions, withTestTransaction } from "../src";

class TestConnectionManager extends PlatformTransactionManager<object> {
    constructor() { super(); }
    protected async beginTransaction() { return { transaction: {}, metadata: { driverName: "provenance" } }; }
    protected async commitTransaction() {}
    protected async rollbackTransaction() {}
    protected async createSavepoint() {}
    protected async rollbackToSavepoint() {}
    protected async releaseSavepoint() {}
    protected createTestConnection() { return Object.create(null); }
}

afterEach(() => clearTransactionManager());

it.each([false, true])("retains withTestConnection denial through nested test sessions and immediate hooks (hook=%s)", async hook => {
    useTransactionManager(new TestConnectionManager());
    await withTestTransaction(async () => {
        await withTestConnection(async () => {
            const nested = () => mockTransactions(async () => {
                let calls = 0;
                await expect(transactional(() => { calls++; })()).rejects.toThrow("forbidden inside a withTestConnection callback");
                expect(calls).toBe(0);
            });
            if (hook) await afterCommit(nested);
            else await nested();
        });
    });
});
