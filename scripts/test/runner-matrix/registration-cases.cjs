const { transactional } = require('@tranjs/core');
const { mockTransactions } = require('@tranjs/testing');

exports.register = ({ test, expect, entry }) => {
    // No manual extend before these tests: the side-effect import/setup must do it.
    require('./matcher-cases.cjs').register({ test, expect });
    test('side-effect registration supports resolves and negation', () => mockTransactions(async tx => {
        const committed = tx.track(function committed() {});
        const outside = tx.track(function outside() {});
        await transactional(committed)();
        outside();
        await expect(Promise.resolve(committed)).resolves.toHaveCommitted();
        await expect(Promise.resolve(committed)).resolves.not.toHaveRolledBack();
        await expect(Promise.resolve(outside)).resolves.toRunOutsideTransaction();
    }));
    test('import plus manual extend safely registers the same six matchers again', async () => {
        const { matchers } = await entry();
        expect(Object.keys(matchers)).toHaveLength(6);
        expect.extend(matchers);
        await mockTransactions(async tx => {
            const committed = tx.track(function committed() {});
            await transactional(committed)();
            expect(committed).toHaveCommitted();
            expect(committed).not.toHaveRolledBack();
            await expect(Promise.resolve(committed)).resolves.toHaveCommitted();
        });
    });
};
