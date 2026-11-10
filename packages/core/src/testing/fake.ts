import { PlatformTransactionManager } from "../manager";
import { MetadataWrappedTransaction } from "../context";

/** Internal no-I/O manager. Not a driver ctx() substitute. */
export class FakeTransactionManager extends PlatformTransactionManager<object> {
    constructor() { super(); }
    protected async beginTransaction(): Promise<MetadataWrappedTransaction<object>> {
        return { transaction: {}, metadata: { driverName: "@tranjs/core/testing" } };
    }
    protected async commitTransaction(): Promise<void> {}
    protected async rollbackTransaction(): Promise<void> {}
    protected async createSavepoint(): Promise<void> {}
    protected async rollbackToSavepoint(): Promise<void> {}
    protected async releaseSavepoint(): Promise<void> {}
}
