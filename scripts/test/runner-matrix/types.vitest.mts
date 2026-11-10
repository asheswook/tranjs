/// <reference types="vitest/globals" />
import { expect as importedExpect } from 'vitest';
import { matchers } from '@tranjs/core/testing/vitest';
for (const check of [expect, importedExpect]) {
check.extend(matchers);
const fn = () => {};
check(fn).toRunInSameTransactionAs(fn);
check(fn).not.toRunInSeparateTransactionFrom(fn);
check(fn).toRunOutsideTransaction();
check(fn).toRunAfterCommitOf(fn);
check(fn).toHaveCommitted();
check(fn).toHaveRolledBack();
check(Promise.resolve(fn)).resolves.toHaveCommitted();
// @ts-expect-error transaction operands must be functions
check(fn).toRunAfterCommitOf(123);
// @ts-expect-error no parameters
check(fn).toRunOutsideTransaction(fn);
}
