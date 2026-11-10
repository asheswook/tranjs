import { TESTING_BRIDGE_VERSION, TESTING_CORE_VERSION } from "@tranjs/core/internal/testing-bridge";

// Validate at load time, before any helper can open a transaction.
if (TESTING_BRIDGE_VERSION !== 1 || TESTING_CORE_VERSION !== "1.2.0") {
    throw new Error(
        `@tranjs/testing 1.2.0 requires @tranjs/core 1.2.0 with testing bridge protocol 1; ` +
        `received core ${String(TESTING_CORE_VERSION)}, bridge protocol ${String(TESTING_BRIDGE_VERSION)}`,
    );
}
