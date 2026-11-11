import type {} from "expect";
import { expect } from "@jest/globals";
import { matchers } from "./index";

expect.extend(matchers);

export { matchers };

declare module "expect" {
    interface Matchers<R extends void | Promise<void>, T = unknown> {
        toRunInSameTransactionAs(other: Function): R;
        toRunInSeparateTransactionFrom(other: Function): R;
        toRunOutsideTransaction(): R;
        toRunAfterCommitOf(other: Function): R;
        toHaveCommitted(): R;
        toHaveRolledBack(): R;
    }
}

declare global {
    namespace jest {
        interface Matchers<R, T = {}> {
            toRunInSameTransactionAs(other: Function): R;
            toRunInSeparateTransactionFrom(other: Function): R;
            toRunOutsideTransaction(): R;
            toRunAfterCommitOf(other: Function): R;
            toHaveCommitted(): R;
            toHaveRolledBack(): R;
        }
    }
}
