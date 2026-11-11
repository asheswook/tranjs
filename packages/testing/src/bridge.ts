import { TESTING_BRIDGE_VERSION } from "@tranjs/core/internal/testing-bridge";

// Validate at load time, before any helper can open a transaction.
if (TESTING_BRIDGE_VERSION !== 1) {
    throw new Error(
        `@tranjs/testing requires testing bridge protocol 1; received protocol ${String(TESTING_BRIDGE_VERSION)}`,
    );
}
