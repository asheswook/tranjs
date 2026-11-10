import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

describe("no-session production fidelity", () => {
    it("matches @tranjs/core@1.1.0 including non-Error commit, combined cleanup, async hooks/logger, identity, and BEGIN expiry probes", () => {
        const output = execFileSync(process.execPath, [resolve(__dirname, "../../../scripts/test/core-no-session-differential.cjs")], {
            cwd: resolve(__dirname, "../../.."),
            encoding: "utf8",
            stdio: "pipe",
            timeout: 120000,
        });
        const result = JSON.parse(output);
        expect(result).toEqual({
            scenarios: expect.any(Number),
            baseline: "@tranjs/core@1.1.0",
            passed: true,
        });
        expect(result.scenarios).toBeGreaterThanOrEqual(85);
    }, 120000);
});
