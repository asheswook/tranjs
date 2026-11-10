const { test, before, after, describe } = require('node:test');
const h = require('./harness.cjs');
before(h.setup);
after(h.cleanup);
test('portable node serial', () => h.portable('serial'));
describe('portable node concurrent', { concurrency: true }, () => {
    test('one', () => h.portable('node-one'));
    test('two', () => h.portable('node-two'));
});
test('all six portable assertions work without runner matchers', () => h.testing.mockTransactions(async tx => {
    const first = tx.track(function first() {});
    const joined = tx.track(function joined() {});
    const separate = tx.track(function separate() {});
    const notification = tx.track(function notification() {});
    const outside = tx.track(function outside() {});
    const rolled = tx.track(function rolled() { throw new Error('application'); });
    await h.core.runInTransaction(async () => {
        first(); joined();
        await h.core.runInTransaction(separate, { propagation: h.core.Propagation.REQUIRES_NEW });
        h.core.afterCommit(notification);
    });
    outside();
    await h.assert.rejects(h.core.runInTransaction(rolled), /application/);
    h.testing.assertSameTransaction(first, joined);
    h.testing.assertSeparateTransaction(first, separate);
    h.testing.assertOutsideTransaction(outside);
    h.testing.assertAfterCommitOf(notification, first);
    h.testing.assertCommitted(first);
    h.testing.assertRolledBack(rolled);
    h.assert.throws(() => h.testing.assertSameTransaction(first, separate), /first/);
    h.assert.throws(() => h.testing.assertCommitted(function untracked() {}), /track/i);
}));
