const { transactional, afterCommit, Propagation } = require('@tranjs/core');
const { mockTransactions } = require('@tranjs/testing');
exports.register = ({ test, expect }) => {
    test('six matchers, negation, and usage errors', () => mockTransactions(async tx => {
        const first = tx.track(function first() {});
        const joined = tx.track(function joined() {});
        const separate = tx.track(function separate() {});
        const notification = tx.track(function notification() {});
        const outside = tx.track(function outside() {});
        const rolled = tx.track(function rolled() { throw new Error('application'); });
        await transactional(async () => {
            first(); joined();
            await transactional(separate, { propagation: Propagation.REQUIRES_NEW })();
            afterCommit(notification);
        })();
        outside();
        await expect(transactional(rolled)()).rejects.toThrow('application');
        expect(first).toRunInSameTransactionAs(joined);
        expect(first).not.toRunInSameTransactionAs(separate);
        expect(first).toRunInSeparateTransactionFrom(separate);
        expect(first).not.toRunInSeparateTransactionFrom(joined);
        expect(outside).toRunOutsideTransaction();
        expect(first).not.toRunOutsideTransaction();
        expect(notification).toRunAfterCommitOf(first);
        expect(outside).not.toRunAfterCommitOf(first);
        expect(first).toHaveCommitted();
        expect(first).not.toHaveRolledBack();
        expect(rolled).toHaveRolledBack();
        expect(rolled).not.toHaveCommitted();
        expect(() => expect(first).toRunInSameTransactionAs(separate)).toThrow(/first.*tx#|first →/s);
        expect(() => expect(function untracked() {}).not.toHaveCommitted()).toThrow(/track/i);
        const never = tx.track(function never() {});
        expect(() => expect(never).not.toHaveCommitted()).toThrow(/exactly one|0 recorded|zero/i);
        const multiple = tx.track(function multiple() {});
        multiple(); multiple();
        expect(() => expect(multiple).not.toRunOutsideTransaction()).toThrow(/exactly one|2 recorded|multiple/i);
    }));
};
