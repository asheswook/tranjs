import {
    MetadataWrappedTransaction,
    PlatformTransactionManager,
    Propagation,
    TransactionContext,
    useTransactionManager,
    Transactional,
} from "../src";

interface DummyTx extends TransactionContext {
    id: number;
}

class RecordingTransactionManager extends PlatformTransactionManager<DummyTx> {
    private nextId = 0;
    readonly events: string[] = [];

    constructor() {
        super();
    }

    async beginTransaction(): Promise<MetadataWrappedTransaction<DummyTx>> {
        const id = ++this.nextId;
        this.events.push(`begin:${id}`);
        return {
            transaction: { id },
            metadata: { driverName: "recording" },
        };
    }

    async commitTransaction(tx: DummyTx): Promise<void> {
        this.events.push(`commit:${tx.id}`);
    }

    async rollbackTransaction(tx: DummyTx): Promise<void> {
        this.events.push(`rollback:${tx.id}`);
    }
}

describe("Nested @Transactional Rollback", () => {
    let manager: RecordingTransactionManager;

    beforeEach(() => {
        manager = new RecordingTransactionManager();
        useTransactionManager(manager);
    });

    afterEach(() => {
        useTransactionManager(undefined as any);
    });

    describe("REQUIRED(outer) + REQUIRED(inner)", () => {
        // inner reuses outer's tx → only one transaction exists
        it("rolls back outer when inner throws", async () => {
            await expect(
                manager.executeTransaction(Propagation.REQUIRED, async () => {
                    await manager.executeTransaction(Propagation.REQUIRED, async () => {
                        throw new Error("inner failure");
                    });
                }),
            ).rejects.toThrow("inner failure");

            expect(manager.events).toEqual([
                "begin:1",
                "rollback:1",
            ]);
        });

        it("rolls back outer when outer throws after inner succeeds", async () => {
            await expect(
                manager.executeTransaction(Propagation.REQUIRED, async () => {
                    await manager.executeTransaction(Propagation.REQUIRED, async () => {
                        return "inner ok";
                    });
                    throw new Error("outer failure after inner");
                }),
            ).rejects.toThrow("outer failure after inner");

            expect(manager.events).toEqual([
                "begin:1",
                "rollback:1",
            ]);
        });

        it("commits only once when both inner and outer succeed", async () => {
            const result = await manager.executeTransaction(Propagation.REQUIRED, async () => {
                const inner = await manager.executeTransaction(Propagation.REQUIRED, async () => {
                    return "inner";
                });
                return `outer-${inner}`;
            });

            expect(result).toBe("outer-inner");
            expect(manager.events).toEqual([
                "begin:1",
                "commit:1",
            ]);
        });
    });

    describe("REQUIRED(outer) + REQUIRES_NEW(inner)", () => {
        // inner creates independent tx. inner throw → inner rollback + rethrow → outer rollback
        it("rolls back both inner and outer when inner throws", async () => {
            await expect(
                manager.executeTransaction(Propagation.REQUIRED, async () => {
                    await manager.executeTransaction(Propagation.REQUIRES_NEW, async () => {
                        throw new Error("inner failure");
                    });
                }),
            ).rejects.toThrow("inner failure");

            expect(manager.events).toEqual([
                "begin:1",
                "begin:2",
                "rollback:2",
                "rollback:1",
            ]);
        });

        it("commits outer when outer catches inner error", async () => {
            const result = await manager.executeTransaction(Propagation.REQUIRED, async () => {
                try {
                    await manager.executeTransaction(Propagation.REQUIRES_NEW, async () => {
                        throw new Error("inner failure");
                    });
                } catch {}
                return "outer survived";
            });

            expect(result).toBe("outer survived");
            expect(manager.events).toEqual([
                "begin:1",
                "begin:2",
                "rollback:2",
                "commit:1",
            ]);
        });

        it("keeps inner committed and rolls back only outer when outer throws after inner succeeds", async () => {
            await expect(
                manager.executeTransaction(Propagation.REQUIRED, async () => {
                    await manager.executeTransaction(Propagation.REQUIRES_NEW, async () => {
                        return "inner ok";
                    });
                    throw new Error("outer failure");
                }),
            ).rejects.toThrow("outer failure");

            expect(manager.events).toEqual([
                "begin:1",
                "begin:2",
                "commit:2",
                "rollback:1",
            ]);
        });
    });

    describe("REQUIRED(outer) + MANDATORY(inner)", () => {
        // MANDATORY: requires existing tx, reuses it → same rollback behavior as REQUIRED
        it("rolls back outer when inner throws", async () => {
            await expect(
                manager.executeTransaction(Propagation.REQUIRED, async () => {
                    await manager.executeTransaction(Propagation.MANDATORY, async () => {
                        throw new Error("mandatory inner failure");
                    });
                }),
            ).rejects.toThrow("mandatory inner failure");

            expect(manager.events).toEqual([
                "begin:1",
                "rollback:1",
            ]);
        });
    });

    describe("REQUIRES_NEW(outer) + REQUIRES_NEW(inner)", () => {
        it("rolls back both transactions when inner throws", async () => {
            await expect(
                manager.executeTransaction(Propagation.REQUIRES_NEW, async () => {
                    await manager.executeTransaction(Propagation.REQUIRES_NEW, async () => {
                        throw new Error("inner failure");
                    });
                }),
            ).rejects.toThrow("inner failure");

            expect(manager.events).toEqual([
                "begin:1",
                "begin:2",
                "rollback:2",
                "rollback:1",
            ]);
        });

        it("independently rolls back inner and commits outer when outer catches", async () => {
            const result = await manager.executeTransaction(Propagation.REQUIRES_NEW, async () => {
                try {
                    await manager.executeTransaction(Propagation.REQUIRES_NEW, async () => {
                        throw new Error("inner failure");
                    });
                } catch {}
                return "outer ok";
            });

            expect(result).toBe("outer ok");
            expect(manager.events).toEqual([
                "begin:1",
                "begin:2",
                "rollback:2",
                "commit:1",
            ]);
        });
    });

    describe("3-level deep nesting", () => {
        // outer(tx1) > middle(REQUIRES_NEW, tx2) > inner(REQUIRED, reuses tx2)
        // inner throw → middle rollback + rethrow → outer rollback
        it("REQUIRED > REQUIRES_NEW > REQUIRED: deepest error rolls back all", async () => {
            await expect(
                manager.executeTransaction(Propagation.REQUIRED, async () => {
                    await manager.executeTransaction(Propagation.REQUIRES_NEW, async () => {
                        await manager.executeTransaction(Propagation.REQUIRED, async () => {
                            throw new Error("deepest failure");
                        });
                    });
                }),
            ).rejects.toThrow("deepest failure");

            expect(manager.events).toEqual([
                "begin:1",
                "begin:2",
                "rollback:2",
                "rollback:1",
            ]);
        });

        it("REQUIRED > REQUIRES_NEW > REQUIRES_NEW: outer commits when middle catches deepest error", async () => {
            const result = await manager.executeTransaction(Propagation.REQUIRED, async () => {
                await manager.executeTransaction(Propagation.REQUIRES_NEW, async () => {
                    try {
                        await manager.executeTransaction(Propagation.REQUIRES_NEW, async () => {
                            throw new Error("deepest failure");
                        });
                    } catch {}
                    return "middle ok";
                });
                return "outer ok";
            });

            expect(result).toBe("outer ok");
            expect(manager.events).toEqual([
                "begin:1",
                "begin:2",
                "begin:3",
                "rollback:3",
                "commit:2",
                "commit:1",
            ]);
        });

        // all REQUIRED → same tx reused → single begin/rollback
        it("REQUIRED > REQUIRED > REQUIRED: single rollback regardless of throw depth", async () => {
            await expect(
                manager.executeTransaction(Propagation.REQUIRED, async () => {
                    await manager.executeTransaction(Propagation.REQUIRED, async () => {
                        await manager.executeTransaction(Propagation.REQUIRED, async () => {
                            throw new Error("deep error");
                        });
                    });
                }),
            ).rejects.toThrow("deep error");

            expect(manager.events).toEqual([
                "begin:1",
                "rollback:1",
            ]);
        });
    });

    describe("nested rollback via @Transactional decorator", () => {
        it("rolls back outer when decorated inner method throws", async () => {
            class Service {
                @Transactional(Propagation.REQUIRED)
                async outer() {
                    await this.inner();
                    return "done";
                }

                @Transactional(Propagation.REQUIRED)
                async inner() {
                    throw new Error("inner decorator failure");
                }
            }

            const service = new Service();
            await expect(service.outer()).rejects.toThrow("inner decorator failure");

            expect(manager.events).toEqual([
                "begin:1",
                "rollback:1",
            ]);
        });

        it("commits outer when outer catches REQUIRES_NEW inner method error", async () => {
            class Service {
                @Transactional(Propagation.REQUIRED)
                async outer() {
                    try {
                        await this.inner();
                    } catch {}
                    return "outer survived";
                }

                @Transactional(Propagation.REQUIRES_NEW)
                async inner() {
                    throw new Error("inner decorator failure");
                }
            }

            const service = new Service();
            const result = await service.outer();

            expect(result).toBe("outer survived");
            expect(manager.events).toEqual([
                "begin:1",
                "begin:2",
                "rollback:2",
                "commit:1",
            ]);
        });

        it("rolls back both outer and inner when REQUIRES_NEW inner error propagates", async () => {
            class Service {
                @Transactional(Propagation.REQUIRED)
                async outer() {
                    await this.inner();
                    return "done";
                }

                @Transactional(Propagation.REQUIRES_NEW)
                async inner() {
                    throw new Error("inner decorator failure");
                }
            }

            const service = new Service();
            await expect(service.outer()).rejects.toThrow("inner decorator failure");

            expect(manager.events).toEqual([
                "begin:1",
                "begin:2",
                "rollback:2",
                "rollback:1",
            ]);
        });
    });

    /**
     * 트리 구조 중첩 테스트 (형제 노드가 있는 branching)
     *
     * Service1.tx1(REQUIRED)
     * ├── Service2.tx2(REQUIRES_NEW)
     * │   ├── LeafService.tx4(REQUIRES_NEW)
     * │   └── LeafService.tx5(REQUIRES_NEW)
     * └── Service3.tx3(REQUIRES_NEW)
     *     ├── LeafService.tx6(REQUIRES_NEW)
     *     └── LeafService.tx7(REQUIRES_NEW)
     *
     * DFS 순서: 4 → 5 → 2 → 6 → 7 → 3 → 1
     */
    describe("tree-structured nesting (branching) - decorator based", () => {
        class LeafService {
            @Transactional(Propagation.REQUIRES_NEW)
            async succeed() { return "ok"; }

            @Transactional(Propagation.REQUIRES_NEW)
            async fail(message: string) { throw new Error(message); }
        }

        class BranchService {
            constructor(private leaf: LeafService) {}

            @Transactional(Propagation.REQUIRES_NEW)
            async succeedWithChildren() {
                await this.leaf.succeed();
                await this.leaf.succeed();
            }

            @Transactional(Propagation.REQUIRES_NEW)
            async failAfterChildren(message: string) {
                await this.leaf.succeed();
                await this.leaf.succeed();
                throw new Error(message);
            }

            @Transactional(Propagation.REQUIRES_NEW)
            async secondChildFails(message: string) {
                await this.leaf.succeed();
                await this.leaf.fail(message);
            }
        }

        let leaf: LeafService;
        let branch: BranchService;

        beforeEach(() => {
            leaf = new LeafService();
            branch = new BranchService(leaf);
        });

        it("commits in DFS post-order when all succeed", async () => {
            class RootService {
                constructor(private b: BranchService) {}

                @Transactional(Propagation.REQUIRED)
                async run() {
                    await this.b.succeedWithChildren();
                    await this.b.succeedWithChildren();
                    return "done";
                }
            }

            const root = new RootService(branch);
            const result = await root.run();

            expect(result).toBe("done");
            expect(manager.events).toEqual([
                "begin:1",
                "begin:2",
                "begin:3", "commit:3",
                "begin:4", "commit:4",
                "commit:2",
                "begin:5",
                "begin:6", "commit:6",
                "begin:7", "commit:7",
                "commit:5",
                "commit:1",
            ]);
        });

        it("keeps tx4,tx5 committed when tx2 fails; tx3 never executes; tx1 rolls back", async () => {
            class RootService {
                constructor(private b: BranchService) {}

                @Transactional(Propagation.REQUIRED)
                async run() {
                    await this.b.failAfterChildren("tx2 failed after children");
                    await this.b.succeedWithChildren();
                    return "done";
                }
            }

            const root = new RootService(branch);
            await expect(root.run()).rejects.toThrow("tx2 failed after children");

            expect(manager.events).toEqual([
                "begin:1",
                "begin:2",
                "begin:3", "commit:3",
                "begin:4", "commit:4",
                "rollback:2",
                "rollback:1",
            ]);
        });

        it("runs tx3 branch normally and commits tx1 when tx1 catches tx2 failure", async () => {
            class RootService {
                constructor(private b: BranchService) {}

                @Transactional(Propagation.REQUIRED)
                async run() {
                    try {
                        await this.b.failAfterChildren("tx2 failed");
                    } catch {}
                    await this.b.succeedWithChildren();
                    return "tx1 survived";
                }
            }

            const root = new RootService(branch);
            const result = await root.run();

            expect(result).toBe("tx1 survived");
            expect(manager.events).toEqual([
                "begin:1",
                "begin:2",
                "begin:3", "commit:3",
                "begin:4", "commit:4",
                "rollback:2",
                "begin:5",
                "begin:6", "commit:6",
                "begin:7", "commit:7",
                "commit:5",
                "commit:1",
            ]);
        });

        it("keeps tx4,tx5 committed; rolls back rest when tx1 catches tx2 then tx3 also fails", async () => {
            class RootService {
                constructor(private b: BranchService) {}

                @Transactional(Propagation.REQUIRED)
                async run() {
                    try {
                        await this.b.failAfterChildren("tx2 failed");
                    } catch {}
                    await this.b.failAfterChildren("tx3 also failed");
                    return "done";
                }
            }

            const root = new RootService(branch);
            await expect(root.run()).rejects.toThrow("tx3 also failed");

            expect(manager.events).toEqual([
                "begin:1",
                "begin:2",
                "begin:3", "commit:3",
                "begin:4", "commit:4",
                "rollback:2",
                "begin:5",
                "begin:6", "commit:6",
                "begin:7", "commit:7",
                "rollback:5",
                "rollback:1",
            ]);
        });

        it("keeps tx4 committed; rolls back tx5, tx2, tx1; tx3 never executes", async () => {
            class RootService {
                constructor(private b: BranchService) {}

                @Transactional(Propagation.REQUIRED)
                async run() {
                    await this.b.secondChildFails("tx5 failed");
                    await this.b.succeedWithChildren();
                    return "done";
                }
            }

            const root = new RootService(branch);
            await expect(root.run()).rejects.toThrow("tx5 failed");

            expect(manager.events).toEqual([
                "begin:1",
                "begin:2",
                "begin:3", "commit:3",
                "begin:4", "rollback:4",
                "rollback:2",
                "rollback:1",
            ]);
        });

        it("rolls back entire single transaction when all siblings use REQUIRED", async () => {
            class RequiredLeaf {
                @Transactional(Propagation.REQUIRED)
                async succeed() { return "ok"; }

                @Transactional(Propagation.REQUIRED)
                async fail(message: string) { throw new Error(message); }
            }

            class RequiredBranch {
                constructor(private leaf: RequiredLeaf) {}

                @Transactional(Propagation.REQUIRED)
                async allSucceed() {
                    await this.leaf.succeed();
                    await this.leaf.succeed();
                }

                @Transactional(Propagation.REQUIRED)
                async firstChildFails(message: string) {
                    await this.leaf.fail(message);
                    await this.leaf.succeed();
                }
            }

            class RequiredRoot {
                constructor(private b: RequiredBranch) {}

                @Transactional(Propagation.REQUIRED)
                async run() {
                    await this.b.allSucceed();
                    await this.b.firstChildFails("tx6 failed");
                    return "done";
                }
            }

            const reqLeaf = new RequiredLeaf();
            const reqBranch = new RequiredBranch(reqLeaf);
            const root = new RequiredRoot(reqBranch);

            await expect(root.run()).rejects.toThrow("tx6 failed");

            expect(manager.events).toEqual([
                "begin:1",
                "rollback:1",
            ]);
        });
    });

    describe("error propagation preserves original error", () => {
        class CustomError extends Error {
            constructor(public code: number) {
                super(`Custom error: ${code}`);
                this.name = "CustomError";
            }
        }

        it("preserves custom error type and properties after nested rollback", async () => {
            try {
                await manager.executeTransaction(Propagation.REQUIRED, async () => {
                    await manager.executeTransaction(Propagation.REQUIRES_NEW, async () => {
                        throw new CustomError(42);
                    });
                });
                fail("should have thrown");
            } catch (e) {
                expect(e).toBeInstanceOf(CustomError);
                expect((e as CustomError).code).toBe(42);
            }

            expect(manager.events).toEqual([
                "begin:1",
                "begin:2",
                "rollback:2",
                "rollback:1",
            ]);
        });
    });
});
