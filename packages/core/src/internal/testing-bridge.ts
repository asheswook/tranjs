// Explicitly internal, versioned cross-package protocol. Not a public API.
export const TESTING_BRIDGE_VERSION = 1;
export const TESTING_CORE_VERSION = "1.2.0";
export * from "../internal";
export { AsyncLocal } from "../asyncLocal";
export type { TxState } from "../asyncLocal";
export { executeFixture } from "./fixture";
