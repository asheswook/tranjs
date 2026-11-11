const { transactional } = require('@tranjs/core');
const { mockTransactions } = require('@tranjs/testing');

// No matcher-entry import or expect.extend: runner config supplies registration.
exports.register = ({ test, expect }) => {
    require('./matcher-cases.cjs').register({ test, expect });
    test('package config registers matchers for resolves and negation', () => mockTransactions(async tx => {
        const committed = tx.track(function committed() {});
        const outside = tx.track(function outside() {});
        await transactional(committed)();
        outside();
        await expect(Promise.resolve(committed)).resolves.toHaveCommitted();
        await expect(Promise.resolve(committed)).resolves.not.toHaveRolledBack();
        await expect(Promise.resolve(outside)).resolves.toRunOutsideTransaction();
        expect(committed).not.toRunOutsideTransaction();
    }));
};
