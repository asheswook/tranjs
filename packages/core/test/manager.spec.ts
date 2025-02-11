import {TransactionContext, PlatformTransactionManager, Propagation, IllegalTransactionStateException, UnsupportedTransactionPropagationException} from "../src";
import {AsyncLocal} from "../src/asyncLocal";

class MockTransactionContext implements TransactionContext {
    execute = jest.fn();
}

class MockTransactionManager extends PlatformTransactionManager<MockTransactionContext> {
    constructor() {
        super();
    }

    beginTransaction = jest.fn(async () => new MockTransactionContext());
    commitTransaction = jest.fn();
    rollbackTransaction = jest.fn();
}

describe('PlatformTransactionManager', () => {
    let manager: MockTransactionManager;

    beforeEach(() => {
        manager = new MockTransactionManager();
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('executeTransaction()', () => {
        describe('propagation - REQUIRED', () => {
            it('should create new transaction when none exists', async () => {
                const callback = jest.fn();
                await manager.executeTransaction(Propagation.REQUIRED, callback);

                expect(manager.beginTransaction).toHaveBeenCalled();
                expect(manager.commitTransaction).toHaveBeenCalled();
            });

            it('should reuse existing transaction', async () => {
                const existingTx = new MockTransactionContext();
                await AsyncLocal.Run(existingTx, async () => {
                    const callback = jest.fn();
                    await manager.executeTransaction(Propagation.REQUIRED, callback);
                });

                expect(manager.beginTransaction).not.toHaveBeenCalled();
                expect(manager.commitTransaction).not.toHaveBeenCalled();
            });

            it('should rollback transaction when thrown', async () => {
                const callback = jest.fn().mockRejectedValue(new Error('error'));
                await expect(manager.executeTransaction(Propagation.REQUIRED, callback)).rejects.toThrow();

                expect(manager.beginTransaction).toHaveBeenCalled();
                expect(manager.rollbackTransaction).toHaveBeenCalled();
            });
        });

        describe('propagation - REQUIRES_NEW', () => {
            it('should create new transaction even if one exists', async () => {
                const existingTx = new MockTransactionContext();
                await AsyncLocal.Run(existingTx, async () => {
                    const callback = jest.fn();
                    await manager.executeTransaction(Propagation.REQUIRES_NEW, callback);

                    expect(manager.beginTransaction).toHaveBeenCalled();
                    expect(manager.commitTransaction).toHaveBeenCalled();
                });
            });

            it('should rollback transaction when thrown', async () => {
                const callback = jest.fn().mockRejectedValue(new Error('error'));
                await expect(manager.executeTransaction(Propagation.REQUIRES_NEW, callback)).rejects.toThrow();

                expect(manager.beginTransaction).toHaveBeenCalled();
                expect(manager.rollbackTransaction).toHaveBeenCalled();
            });
        });

        describe('propagation - MANDATORY', () => {
            it('should throw if no existing transaction', async () => {
                await expect(
                    manager.executeTransaction(Propagation.MANDATORY, jest.fn())
                ).rejects.toThrow(IllegalTransactionStateException);
            });

            it('should use existing transaction', async () => {
                const existingTx = new MockTransactionContext();
                await AsyncLocal.Run(existingTx, async () => {
                    const callback = jest.fn();
                    await manager.executeTransaction(Propagation.MANDATORY, callback);

                    expect(manager.beginTransaction).not.toHaveBeenCalled();
                });
            });
        });

        it('should throw for unsupported propagation', async () => {
            await expect(
                manager.executeTransaction('INVALID' as Propagation, jest.fn())
            ).rejects.toThrow(UnsupportedTransactionPropagationException);
        });
    });
});