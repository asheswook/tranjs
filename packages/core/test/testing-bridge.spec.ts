import * as bridge from "../src/internal/testing-bridge";
import { AsyncLocal } from "../src";
import * as internal from "../src/internal";
import { executeFixture } from "../src/internal/fixture";

it("keeps the internal testing protocol on the production singleton", () => {
    expect(bridge.TESTING_BRIDGE_VERSION).toBe(1);
    expect(bridge.TESTING_CORE_VERSION).toBe("1.2.0");
    expect(bridge.AsyncLocal).toBe(AsyncLocal);
    expect(bridge.testAccess).toBe(internal.testAccess);
    expect(bridge.executeFixture).toBe(executeFixture);
});
