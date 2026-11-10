import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

describe("P6: no-session production fidelity", () => {
    it("matches main including non-Error commit, combined cleanup, async hooks/logger, identity, and BEGIN expiry probes", () => {
        const output = execFileSync(process.execPath, [resolve(__dirname, "../../../scripts/test/core-no-session-differential.cjs")], {
            cwd: resolve(__dirname, "../../.."),
            encoding: "utf8",
            stdio: "pipe",
            timeout: 120000,
        });
        const result = JSON.parse(output);
        expect(result).toEqual({
            scenarios: expect.any(Number),
            baseline: expect.stringMatching(/^[0-9a-f]{40}$/),
            passed: true,
        });
        expect(result.scenarios).toBeGreaterThanOrEqual(85);
    }, 120000);
});
