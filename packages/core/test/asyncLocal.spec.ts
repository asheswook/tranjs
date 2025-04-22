import { AsyncLocal } from "../src/asyncLocal";
import { MetadataWrappedTransaction, TransactionContext } from "../src";

describe('AsyncLocal', () => {
    describe('Context', () => {
        it('should return undefined when no context is set', () => {
            expect(AsyncLocal.Context).toBeUndefined();
        });
    });

    describe('Run()', () => {
        it('should set context accessible within callback', () => {
            const mockContext = { transaction: {}, metadata: { driverName: 'mock' } } satisfies MetadataWrappedTransaction<TransactionContext>;

            AsyncLocal.Run(mockContext, () => {
                expect(AsyncLocal.Context).toBe(mockContext);
            });

            expect(AsyncLocal.Context).toBeUndefined();
        });
        
        it('should set the context within nested Run calls', () => {
            const mockContext1 = { transaction: {}, metadata: { driverName: 'mock' } } satisfies MetadataWrappedTransaction<TransactionContext>;
            const mockContext2 = { transaction: {}, metadata: { driverName: 'mock' } } satisfies MetadataWrappedTransaction<TransactionContext>;

            AsyncLocal.Run(mockContext1, () => {
                expect(AsyncLocal.Context).toBe(mockContext1);

                AsyncLocal.Run(mockContext2, () => {
                    expect(AsyncLocal.Context).toBe(mockContext2);
                });

                expect(AsyncLocal.Context).toBe(mockContext1);
            });

            expect(AsyncLocal.Context).toBeUndefined();
        })
    });
});