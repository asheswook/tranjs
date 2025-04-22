import { ctx, IllegalTransactionStateException, MetadataWrappedTransaction, PlatformTransactionManager, Propagation, TransactionContext, UnsupportedTransactionPropagationException, useTransactionManager } from "../src";
import { AsyncLocal } from "../src/asyncLocal";

// Dummy transaction 타입 정의
interface DummyTx extends TransactionContext {
    id: number;
}

// 테스트용 트랜잭션 매니저 구현
class DummyTransactionManager extends PlatformTransactionManager<DummyTx> {
    beginTransactionCalls = 0;
    commitCalls = 0;
    rollbackCalls = 0;
    lastBeginTxId = 0;

    constructor() {
        super();
    }

    async beginTransaction(): Promise<MetadataWrappedTransaction<DummyTx>> {
        this.beginTransactionCalls++;
        this.lastBeginTxId = this.beginTransactionCalls;
        return {
            transaction: { id: this.lastBeginTxId },
            metadata: { driverName: "dummy" },
        };
    }

    async commitTransaction(tx: DummyTx): Promise<void> {
        this.commitCalls++;
    }

    async rollbackTransaction(tx: DummyTx): Promise<void> {
        this.rollbackCalls++;
    }
}

describe("PlatformTransactionManager", () => {
    let manager: DummyTransactionManager;
    let originalContext: jest.SpyInstance;
    let originalRun: jest.SpyInstance;

    beforeEach(() => {
        manager = new DummyTransactionManager();
        useTransactionManager(manager);

        // AsyncLocal.Context와 AsyncLocal.Run 메소드를 mock
        originalContext = jest.spyOn(AsyncLocal, "Context", "get");
        originalRun = jest.spyOn(AsyncLocal, "Run");
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    // 1. ctx() 호출 시 트랜잭션 컨텍스트가 없으면 오류 발생 여부
    test("ctx() throws if no context is available", () => {
        originalContext.mockReturnValue(undefined);
        expect(() => ctx<DummyTx>()).toThrow("No transaction context available");
    });

    // 2. REQUIRED 프로퍼게이션: 기존 컨텍스트가 없으면 새로운 트랜잭션 생성
    test("executeTransaction with REQUIRED without existing transaction starts new transaction", async () => {
        // 기존 컨텍스트 없음 설정
        originalContext.mockReturnValue(undefined);

        // AsyncLocal.Run 모의 구현
        originalRun.mockImplementation((context, callback) => {
            // Run이 실행되면 컨텍스트를 일시적으로 설정하고 콜백을 실행
            const wrappedTx = context as MetadataWrappedTransaction<DummyTx>;
            originalContext.mockReturnValueOnce(wrappedTx); // 콜백 실행 중에만 컨텍스트 설정
            const result = callback();
            originalContext.mockReturnValue(undefined); // 콜백 실행 후 컨텍스트 해제
            return result;
        });

        const result = await manager.executeTransaction(Propagation.REQUIRED, async (tx) => {
            expect(tx.id).toBe(1);
            return "success";
        });

        expect(result).toBe("success");
        expect(manager.beginTransactionCalls).toBe(1);
        expect(manager.commitCalls).toBe(1);
        expect(manager.rollbackCalls).toBe(0);
    });

    // 3. REQUIRED 프로퍼게이션: 기존 컨텍스트가 있으면 해당 트랜잭션 재사용
    test("executeTransaction with REQUIRED with existing transaction reuses it", async () => {
        // 기존 트랜잭션 컨텍스트 설정
        const existingTx: MetadataWrappedTransaction<DummyTx> = {
            transaction: { id: 999 },
            metadata: { driverName: "dummy" }
        };
        originalContext.mockReturnValue(existingTx);

        const result = await manager.executeTransaction(Propagation.REQUIRED, async (tx) => {
            expect(tx.id).toBe(999); // 기존 트랜잭션의 ID
            return "reuse";
        });

        expect(result).toBe("reuse");
        // 기존 트랜잭션 재사용시 beginTransaction, commit, rollback 호출되지 않음
        expect(manager.beginTransactionCalls).toBe(0);
        expect(manager.commitCalls).toBe(0);
        expect(manager.rollbackCalls).toBe(0);
    });

    // 4. REQUIRES_NEW 프로퍼게이션: 항상 새로운 트랜잭션 생성
    test("executeTransaction with REQUIRES_NEW always starts a new transaction", async () => {
        // 기존 트랜잭션 컨텍스트 존재하지만 무시됨
        const existingTx: MetadataWrappedTransaction<DummyTx> = {
            transaction: { id: 888 },
            metadata: { driverName: "dummy" }
        };
        originalContext.mockReturnValue(existingTx);

        // AsyncLocal.Run 모의 구현
        originalRun.mockImplementation((context, callback) => {
            // Run이 실행되면 새 컨텍스트로 설정하고 콜백 실행
            const wrappedTx = context as MetadataWrappedTransaction<DummyTx>;
            originalContext.mockReturnValueOnce(wrappedTx);
            const result = callback();
            originalContext.mockReturnValue(existingTx); // 콜백 실행 후 원래 컨텍스트로 복원
            return result;
        });

        const result = await manager.executeTransaction(Propagation.REQUIRES_NEW, async (tx) => {
            // REQUIRES_NEW는 항상 새 트랜잭션 시작
            expect(tx.id).toBe(1); // beginTransaction에서 생성된 새 ID
            return "new";
        });

        expect(result).toBe("new");
        expect(manager.beginTransactionCalls).toBe(1);
        expect(manager.commitCalls).toBe(1);
        expect(manager.rollbackCalls).toBe(0);
    });

    // 5. MANDATORY 프로퍼게이션: 기존 트랜잭션이 있을 경우 정상 처리
    test("executeTransaction with MANDATORY with existing transaction works", async () => {
        // 기존 트랜잭션 컨텍스트 설정
        const existingTx: MetadataWrappedTransaction<DummyTx> = {
            transaction: { id: 777 },
            metadata: { driverName: "dummy" }
        };
        originalContext.mockReturnValue(existingTx);

        const result = await manager.executeTransaction(Propagation.MANDATORY, async (tx) => {
            expect(tx.id).toBe(777);
            return "mandatory";
        });

        expect(result).toBe("mandatory");
        expect(manager.beginTransactionCalls).toBe(0);
        expect(manager.commitCalls).toBe(0);
        expect(manager.rollbackCalls).toBe(0);
    });

    // 6. MANDATORY 프로퍼게이션: 기존 트랜잭션 없이 호출 시 예외 발생
    test("executeTransaction with MANDATORY without existing transaction throws error", async () => {
        originalContext.mockReturnValue(undefined);

        await expect(
            manager.executeTransaction(Propagation.MANDATORY, async (tx) => "fail")
        ).rejects.toThrow(IllegalTransactionStateException);
    });

    // 7. 지원하지 않는 프로퍼게이션 타입 테스트
    test("executeTransaction with unsupported propagation throws error", async () => {
        originalContext.mockReturnValue(undefined);

        await expect(
            manager.executeTransaction("unsupported" as any, async (tx) => "fail")
        ).rejects.toThrow(UnsupportedTransactionPropagationException);
    });

    // 8. 성공적인 콜백 실행 시 commitTransaction 호출 확인
    test("commitTransaction is called on successful callback execution", async () => {
        originalContext.mockReturnValue(undefined);

        // AsyncLocal.Run 모의 구현
        originalRun.mockImplementation((context, callback) => {
            const wrappedTx = context as MetadataWrappedTransaction<DummyTx>;
            originalContext.mockReturnValueOnce(wrappedTx);
            const result = callback();
            originalContext.mockReturnValue(undefined);
            return result;
        });

        await manager.executeTransaction(Propagation.REQUIRED, async (tx) => "ok");

        expect(manager.commitCalls).toBe(1);
        expect(manager.rollbackCalls).toBe(0);
    });

    // 9. 콜백 오류 발생 시 rollbackTransaction 호출 확인
    test("rollbackTransaction is called on callback error", async () => {
        originalContext.mockReturnValue(undefined);

        // AsyncLocal.Run 모의 구현
        originalRun.mockImplementation((context, callback) => {
            const wrappedTx = context as MetadataWrappedTransaction<DummyTx>;
            originalContext.mockReturnValueOnce(wrappedTx);
            try {
                const result = callback();
                originalContext.mockReturnValue(undefined);
                return result;
            } catch (error) {
                originalContext.mockReturnValue(undefined);
                throw error;
            }
        });

        await expect(
            manager.executeTransaction(Propagation.REQUIRED, async (tx) => {
                throw new Error("fail");
            })
        ).rejects.toThrow("fail");

        expect(manager.commitCalls).toBe(0);
        expect(manager.rollbackCalls).toBe(1);
    });

    // 10. 메타데이터 검증
    test("metadata is correctly exposed in transaction context", async () => {
        originalContext.mockReturnValue(undefined);

        // AsyncLocal.Run 모의 구현
        originalRun.mockImplementation((context, callback) => {
            const wrappedTx = context as MetadataWrappedTransaction<DummyTx>;
            expect(wrappedTx.metadata.driverName).toBe("dummy"); // 메타데이터 검증
            originalContext.mockReturnValueOnce(wrappedTx);
            const result = callback();
            originalContext.mockReturnValue(undefined);
            return result;
        });

        await manager.executeTransaction(Propagation.REQUIRED, async (tx) => "ok");
    });

    // 11. 비동기 및 동기 콜백 처리 검증
    test("transaction manager handles both async and sync callbacks", async () => {
        originalContext.mockReturnValue(undefined);

        // AsyncLocal.Run 모의 구현
        originalRun.mockImplementation((context, callback) => {
            const wrappedTx = context as MetadataWrappedTransaction<DummyTx>;
            originalContext.mockReturnValueOnce(wrappedTx);
            const result = callback();
            originalContext.mockReturnValue(undefined);
            return result;
        });

        // 동기 콜백
        const syncResult = await manager.executeTransaction(Propagation.REQUIRED, (tx) => "sync");
        expect(syncResult).toBe("sync");

        // 비동기 콜백
        const asyncResult = await manager.executeTransaction(Propagation.REQUIRED, async (tx) => {
            return Promise.resolve("async");
        });
        expect(asyncResult).toBe("async");
    });

    // 12. 중첩 트랜잭션 테스트
    test("nested transactions with different propagation behavior correctly", async () => {
        // 바깥 트랜잭션의 컨텍스트를 설정
        const outerTx: MetadataWrappedTransaction<DummyTx> = {
            transaction: { id: 111 },
            metadata: { driverName: "dummy" }
        };

        // 새 트랜잭션의 컨텍스트 (inner tx)
        let innerContextSet = false;
        let capturedInnerContext: MetadataWrappedTransaction<DummyTx> | undefined;

        // 초기 상태: 외부 트랜잭션 컨텍스트 설정
        originalContext.mockImplementation(() => {
            if (innerContextSet) {
                return capturedInnerContext;
            }
            return outerTx;
        });

        // Run 메소드 모의 구현
        originalRun.mockImplementation((context, callback) => {
            // 내부 트랜잭션 컨텍스트 캡처
            capturedInnerContext = context as MetadataWrappedTransaction<DummyTx>;
            innerContextSet = true;

            try {
                const result = callback();
                return result;
            } finally {
                innerContextSet = false;
                capturedInnerContext = undefined;
            }
        });

        // 외부 REQUIRED + 내부 REQUIRES_NEW 테스트
        const result = await manager.executeTransaction(Propagation.REQUIRED, async (outerTxInstance) => {
            expect(outerTxInstance.id).toBe(111); // 외부 트랜잭션 ID

            const innerResult = await manager.executeTransaction(Propagation.REQUIRES_NEW, async (innerTxInstance) => {
                expect(innerTxInstance.id).toBe(1); // 내부 새 트랜잭션 ID
                return "inner";
            });

            return `outer-${innerResult}`;
        });

        expect(result).toBe("outer-inner");
        // 새 트랜잭션 시작은 내부 트랜잭션에 대해서만 발생
        expect(manager.beginTransactionCalls).toBe(1);
        expect(manager.commitCalls).toBe(1);
    });
});
