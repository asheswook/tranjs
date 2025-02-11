import {AsyncLocal} from "../src/asyncLocal";
import {TransactionContext} from "../src";

describe('AsyncLocal', () => {
    describe('Context', () => {
        it('should return undefined when no context is set', () => {
            expect(AsyncLocal.Context).toBeUndefined();
        });
    });

    describe('Run()', () => {
        it('should set context accessible within callback', () => {
            const mockContext = { execute: jest.fn() } as unknown as TransactionContext;

            AsyncLocal.Run(mockContext, () => {
                expect(AsyncLocal.Context).toBe(mockContext);
            });

            expect(AsyncLocal.Context).toBeUndefined();
        });
        
        it('should set the context within nested Run calls', () => {
            const mockContext1 = { execute: jest.fn() } as unknown as TransactionContext;
            const mockContext2 = { execute: jest.fn() } as unknown as TransactionContext;

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