import { expect as importedExpect } from '@jest/globals';
import { expect as packageExpect } from 'expect';

// Augmentation comes only from compilerOptions.types, not a matcher-entry import.
const fn = () => {};
for (const check of [expect, importedExpect, packageExpect]) {
    check(fn).toRunInSameTransactionAs(fn);
    check(fn).not.toRunInSeparateTransactionFrom(fn);
    check(fn).toRunOutsideTransaction();
    check(fn).toRunAfterCommitOf(fn);
    check(fn).toHaveCommitted();
    check(fn).toHaveRolledBack();
    check(Promise.resolve(fn)).resolves.toHaveCommitted();
    check(Promise.resolve(fn)).resolves.not.toHaveRolledBack();
    // @ts-expect-error Transaction operands must be functions.
    check(fn).toRunInSameTransactionAs(123);
    // @ts-expect-error No arguments are accepted.
    check(fn).toHaveCommitted(fn);
}
