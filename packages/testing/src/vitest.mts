import type {} from "vitest";

export { matchers } from "./index.js";

declare module "vitest" {
    // A parameterless merge supports the different Assertion generics in 3/4/5.
    interface Assertion {
        toRunInSameTransactionAs(other: Function): ReturnType<this["toBeDefined"]>;
        toRunInSeparateTransactionFrom(other: Function): ReturnType<this["toBeDefined"]>;
        toRunOutsideTransaction(): ReturnType<this["toBeDefined"]>;
        toRunAfterCommitOf(other: Function): ReturnType<this["toBeDefined"]>;
        toHaveCommitted(): ReturnType<this["toBeDefined"]>;
        toHaveRolledBack(): ReturnType<this["toBeDefined"]>;
    }
}
