import '@tranjs/testing/jest';
import { matchers } from '@tranjs/testing/jest';
import { expect as importedExpect } from '@jest/globals';
import { expect as packageExpect } from 'expect';
expect.extend(matchers);
const fn = () => {};
expect(fn).toRunInSameTransactionAs(fn);
expect(fn).not.toRunInSeparateTransactionFrom(fn);
expect(fn).toRunOutsideTransaction();
expect(fn).toRunAfterCommitOf(fn);
expect(fn).toHaveCommitted();
expect(fn).toHaveRolledBack();
expect(Promise.resolve(fn)).resolves.toHaveCommitted();
importedExpect(Promise.resolve(fn)).resolves.not.toHaveRolledBack();
// @ts-expect-error transaction operands must be functions
expect(fn).toRunInSameTransactionAs(123);
// @ts-expect-error no parameters
expect(fn).toHaveCommitted(fn);

for (const check of [importedExpect, packageExpect]) {
    check.extend(matchers);
    check(fn).toRunInSameTransactionAs(fn);
    check(fn).not.toRunInSeparateTransactionFrom(fn);
    check(fn).toRunOutsideTransaction();
    check(fn).toRunAfterCommitOf(fn);
    check(fn).toHaveCommitted();
    check(fn).toHaveRolledBack();
    // @ts-expect-error transaction operands must be functions
    check(fn).toRunInSameTransactionAs(123);
    // @ts-expect-error no parameters
    check(fn).toHaveCommitted(fn);
}
