import { afterCommit, Propagation, runInTransaction, Transactional } from "@tranjs/core";
import {
    assertAfterCommitOf, assertCommitted, assertOutsideTransaction, assertRolledBack,
    assertSameTransaction, assertSeparateTransaction, matchers, mockTransactions, TestTransactionProbe,
} from "../src";

expect.extend(matchers);
type BoundaryExpectation = Record<keyof typeof matchers, (other?: Function) => void> & { not: BoundaryExpectation };
const boundary = (fn: Function) => expect(fn) as unknown as BoundaryExpectation;
function message(fn: () => void): string {
    try { fn(); }
    catch (error) { return (error as Error).message; }
    throw new Error("Expected a diagnostic, but the assertion passed");
}

interface Repository {
    insertOrder(): Promise<void>;
    insertAudit(): Promise<void>;
}
interface Mailer { sendReceipt(): Promise<void>; }

class AuditService {
    constructor(protected readonly repository: Repository) {}
    @Transactional()
    async recordAudit(): Promise<void> { await this.repository.insertAudit(); }
}
class IndependentAuditService extends AuditService {
    // Agent mistake: an atomic write was changed from REQUIRED to REQUIRES_NEW.
    @Transactional(Propagation.REQUIRES_NEW)
    async recordAudit(): Promise<void> { await this.repository.insertAudit(); }
}
class OrderService {
    constructor(protected readonly repository: Repository, protected readonly audit: AuditService, protected readonly mailer: Mailer) {}
    protected async writeOrder(): Promise<void> {
        await this.repository.insertOrder();
        await this.audit.recordAudit();
    }
    @Transactional()
    async placeOrder(): Promise<void> {
        await this.writeOrder();
        await afterCommit(() => this.mailer.sendReceipt());
    }
}
class MissingDecoratorOrderService extends OrderService {
    // Agent mistake: @Transactional was removed from the entry point.
    async placeOrder(): Promise<void> {
        await this.writeOrder();
        await afterCommit(() => this.mailer.sendReceipt());
    }
}
class PrematureEmailOrderService extends OrderService {
    @Transactional()
    async placeOrder(): Promise<void> {
        await this.writeOrder();
        // Agent mistake: the side effect moved from afterCommit into the body.
        await this.mailer.sendReceipt();
    }
}
function sample(t: TestTransactionProbe, Order = OrderService, Audit = AuditService) {
    const repository = t.track({ async insertOrder() {}, async insertAudit() {} });
    const mailer = t.track({ async sendReceipt() {} });
    return { repository, mailer, service: new Order(repository, new Audit(repository), mailer) };
}

describe("P5: actionable diagnostics for agent-style service mistakes", () => {
    it("names explicit mocks and unnamed object properties in an actionable debit/credit diagnostic", async () => {
        await mockTransactions(async t => {
            const accounts = t.track({ debit: jest.fn().mockName('accounts.debit'), credit: jest.fn() });
            await runInTransaction(accounts.debit);
            accounts.credit();
            expect(message(() => assertSameTransaction(accounts.debit, accounts.credit))).toMatchInlineSnapshot(`
"Expected tracked function toRunInSameTransactionAs(other)
Received: accounts.debit → tx#1 (REQUIRED, committed), event 1
Other: credit → outside transaction, event 3"
`);
        });
    });

    it("accepts the correctly decorated, atomic service with email after commit", async () => {
        await mockTransactions(async t => {
            const { repository, mailer, service } = sample(t);
            await service.placeOrder();
            assertSameTransaction(repository.insertOrder, repository.insertAudit);
            assertCommitted(repository.insertOrder);
            assertOutsideTransaction(mailer.sendReceipt);
            assertAfterCommitOf(mailer.sendReceipt, repository.insertOrder);
            boundary(repository.insertOrder).toRunInSameTransactionAs(repository.insertAudit);
            boundary(repository.insertOrder).toHaveCommitted();
            boundary(mailer.sendReceipt).toRunOutsideTransaction();
            boundary(mailer.sendReceipt).toRunAfterCommitOf(repository.insertOrder);
            expect({
                negatedOutside: message(() => boundary(mailer.sendReceipt).not.toRunOutsideTransaction()),
                negatedAfterCommit: message(() => boundary(mailer.sendReceipt).not.toRunAfterCommitOf(repository.insertOrder)),
            }).toMatchInlineSnapshot(`
{
  "negatedAfterCommit": "Expected tracked function not toRunAfterCommitOf(other)
Received: sendReceipt → outside transaction, event 4, afterCommit callback
Other: insertOrder → tx#1 (REQUIRED, committed), event 1
Requires an observed afterCommit callback for the committed transaction (later outside calls do not qualify).",
  "negatedOutside": "Expected tracked function not toRunOutsideTransaction()
Received: sendReceipt → outside transaction, event 4, afterCommit callback",
}
`);
        });
    });

    it("identifies the outside write after @Transactional is removed", async () => {
        await mockTransactions(async t => {
            const { repository, service } = sample(t, MissingDecoratorOrderService);
            await service.placeOrder();
            const diagnostic = message(() => assertSameTransaction(repository.insertOrder, repository.insertAudit));
            expect(diagnostic).toMatchInlineSnapshot(`
"Expected tracked function toRunInSameTransactionAs(other)
Received: insertOrder → outside transaction, event 1
Other: insertAudit → tx#1 (REQUIRED, committed), event 2"
`);
            expect(message(() => boundary(repository.insertOrder).toRunInSameTransactionAs(repository.insertAudit))).toBe(diagnostic);
        });
    });

    it("names both physical transactions and the flipped REQUIRES_NEW propagation", async () => {
        await mockTransactions(async t => {
            const { repository, service } = sample(t, OrderService, IndependentAuditService);
            await service.placeOrder();
            const diagnostic = message(() => assertSameTransaction(repository.insertOrder, repository.insertAudit));
            expect(diagnostic).toMatchInlineSnapshot(`
"Expected tracked function toRunInSameTransactionAs(other)
Received: insertOrder → tx#1 (REQUIRED, committed), event 1
Other: insertAudit → tx#2 (REQUIRES_NEW, committed), event 2"
`);
            expect(message(() => boundary(repository.insertOrder).toRunInSameTransactionAs(repository.insertAudit))).toBe(diagnostic);
            assertSeparateTransaction(repository.insertOrder, repository.insertAudit);
            boundary(repository.insertOrder).toRunInSeparateTransactionFrom(repository.insertAudit);
            expect(message(() => boundary(repository.insertOrder).not.toRunInSeparateTransactionFrom(repository.insertAudit))).toMatchInlineSnapshot(`
"Expected tracked function not toRunInSeparateTransactionFrom(other)
Received: insertOrder → tx#1 (REQUIRED, committed), event 1
Other: insertAudit → tx#2 (REQUIRES_NEW, committed), event 2"
`);
        });
    });

    it("identifies email inside the transaction instead of an afterCommit callback", async () => {
        await mockTransactions(async t => {
            const { repository, mailer, service } = sample(t, PrematureEmailOrderService);
            await service.placeOrder();
            const diagnostic = message(() => assertAfterCommitOf(mailer.sendReceipt, repository.insertOrder));
            expect(diagnostic).toMatchInlineSnapshot(`
"Expected tracked function toRunAfterCommitOf(other)
Received: sendReceipt → tx#1 (REQUIRED, committed), event 3
Other: insertOrder → tx#1 (REQUIRED, committed), event 1
Requires an observed afterCommit callback for the committed transaction (later outside calls do not qualify)."
`);
            expect(message(() => boundary(mailer.sendReceipt).toRunAfterCommitOf(repository.insertOrder))).toBe(diagnostic);
            expect(message(() => assertOutsideTransaction(mailer.sendReceipt))).toMatchInlineSnapshot(`
"Expected tracked function toRunOutsideTransaction()
Received: sendReceipt → tx#1 (REQUIRED, committed), event 3"
`);
        });
    });

    it("does not confuse an unrelated later email with afterCommit provenance", async () => {
        await mockTransactions(async t => {
            const insertOrder = t.track(function insertOrder() {});
            const sendReceipt = t.track(function sendReceipt() {});
            await runInTransaction(insertOrder);
            sendReceipt();
            expect(message(() => assertAfterCommitOf(sendReceipt, insertOrder))).toMatchInlineSnapshot(`
"Expected tracked function toRunAfterCommitOf(other)
Received: sendReceipt → outside transaction, event 3
Other: insertOrder → tx#1 (REQUIRED, committed), event 1
Requires an observed afterCommit callback for the committed transaction (later outside calls do not qualify)."
`);
        });
    });

    it("snapshots separate-transaction and outcome failures, including .not", async () => {
        await mockTransactions(async t => {
            const insertOrder = t.track(function insertOrder() {});
            const insertAudit = t.track(function insertAudit() {});
            const failedWrite = t.track(function failedWrite() {});
            await runInTransaction(() => { insertOrder(); insertAudit(); });
            await expect(runInTransaction(() => { failedWrite(); throw new Error("write failed"); })).rejects.toThrow("write failed");
            assertRolledBack(failedWrite);
            boundary(failedWrite).toHaveRolledBack();
            boundary(failedWrite).not.toHaveCommitted();
            boundary(insertOrder).not.toHaveRolledBack();
            boundary(insertOrder).not.toRunInSeparateTransactionFrom(insertAudit);
            expect({
                separate: message(() => assertSeparateTransaction(insertOrder, insertAudit)),
                committed: message(() => assertCommitted(failedWrite)),
                rolledBack: message(() => assertRolledBack(insertOrder)),
                negatedSame: message(() => boundary(insertOrder).not.toRunInSameTransactionAs(insertAudit)),
                negatedCommitted: message(() => boundary(insertOrder).not.toHaveCommitted()),
                negatedRolledBack: message(() => boundary(failedWrite).not.toHaveRolledBack()),
            }).toMatchInlineSnapshot(`
{
  "committed": "Expected tracked function toHaveCommitted()
Received: failedWrite → tx#2 (REQUIRED, rolled-back), event 4",
  "negatedCommitted": "Expected tracked function not toHaveCommitted()
Received: insertOrder → tx#1 (REQUIRED, committed), event 1",
  "negatedRolledBack": "Expected tracked function not toHaveRolledBack()
Received: failedWrite → tx#2 (REQUIRED, rolled-back), event 4",
  "negatedSame": "Expected tracked function not toRunInSameTransactionAs(other)
Received: insertOrder → tx#1 (REQUIRED, committed), event 1
Other: insertAudit → tx#1 (REQUIRED, committed), event 2",
  "rolledBack": "Expected tracked function toHaveRolledBack()
Received: insertOrder → tx#1 (REQUIRED, committed), event 1",
  "separate": "Expected tracked function toRunInSeparateTransactionFrom(other)
Received: insertOrder → tx#1 (REQUIRED, committed), event 1
Other: insertAudit → tx#1 (REQUIRED, committed), event 2",
}
`);
        });
    });

    it("reports missing and ambiguous evidence as usage errors even under .not", async () => {
        await mockTransactions(async t => {
            const neverCalled = t.track(function neverCalled() {});
            const calledTwice = t.track(function calledTwice() {});
            calledTwice();
            calledTwice();
            expect({
                untracked: message(() => boundary(function untracked() {}).not.toRunOutsideTransaction()),
                missing: message(() => boundary(neverCalled).not.toHaveCommitted()),
                ambiguous: message(() => boundary(calledTwice).not.toHaveRolledBack()),
            }).toMatchInlineSnapshot(`
{
  "ambiguous": "toHaveRolledBack: received must have exactly one recorded call; received 2",
  "missing": "toHaveCommitted: received must have exactly one recorded call; received 0",
  "untracked": "toRunOutsideTransaction: received must be a function tracked by transactions().track or the test probe's track",
}
`);
        });
    });

    it.each(Object.keys(matchers) as (keyof typeof matchers)[])("never lets .not %s pass with untracked, zero-call or multiple-call operands", async matcher => {
        await mockTransactions(t => {
            const once = t.track(function once() {});
            const neverCalled = t.track(function neverCalled() {});
            const twice = t.track(function twice() {});
            once(); twice(); twice();
            expect(() => boundary(function untracked() {}).not[matcher](once)).toThrow(new TypeError(
                `${matcher}: received must be a function tracked by transactions().track or the test probe's track`,
            ));
            expect(() => boundary(neverCalled).not[matcher](once)).toThrow(new TypeError(
                `${matcher}: received must have exactly one recorded call; received 0`,
            ));
            expect(() => boundary(twice).not[matcher](once)).toThrow(new TypeError(
                `${matcher}: received must have exactly one recorded call; received 2`,
            ));
        });
    });

    it.each(["toRunInSameTransactionAs", "toRunInSeparateTransactionFrom", "toRunAfterCommitOf"] as const)("validates the other operand and probe ownership under .not %s", async matcher => {
        let foreign!: () => void;
        await mockTransactions(t => { foreign = t.track(function foreign() {}); foreign(); });
        await mockTransactions(t => {
            const once = t.track(function once() {});
            const neverCalled = t.track(function neverCalled() {});
            once();
            expect(() => boundary(once).not[matcher](neverCalled)).toThrow(new TypeError(
                `${matcher}: other must have exactly one recorded call; received 0`,
            ));
            expect(() => boundary(once).not[matcher](foreign)).toThrow(new TypeError(
                `${matcher}: Functions belong to different transaction probes`,
            ));
        });
    });
});
