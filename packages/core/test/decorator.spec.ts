import {Transactional, Propagation, PlatformTransactionManager, useTransactionManager, DatasourceSetupError, TransactionContext} from "../src";

class MockManager extends PlatformTransactionManager<TransactionContext> {
    constructor() {
        super();
    }
    beginTransaction = jest.fn();
    commitTransaction = jest.fn();
    rollbackTransaction = jest.fn();
}

describe('Transactional Decorator', () => {
    class TestClass {
        @Transactional(Propagation.REQUIRED)
        async testMethod() { return 'result'; }
    }

    afterEach(() => {
        // Reset global manager
        useTransactionManager(undefined as any);
    });

    it('should throw DatasourceSetupError if manager not set', async () => {
        const instance = new TestClass();
        await expect(instance.testMethod()).rejects.toThrow(DatasourceSetupError);
    });

    it('should execute method with transaction when manager is set', async () => {
        const mockManager = new MockManager();
        useTransactionManager(mockManager);

        const instance = new TestClass();
        await instance.testMethod();

        expect(mockManager.beginTransaction).toHaveBeenCalled();
        expect(mockManager.commitTransaction).toHaveBeenCalled();
    });
});