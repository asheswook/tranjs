import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

describe("no-session production fidelity", () => {
    it("preserves 88 @tranjs/core@1.1.0 probes and asserts closed connections, implicit named hooks/ctx and outcome-aware hooks as intended differences", () => {
        const output = execFileSync(process.execPath, [resolve(__dirname, "../../../scripts/test/core-no-session-differential.cjs")], {
            cwd: resolve(__dirname, "../../.."),
            encoding: "utf8",
            stdio: "pipe",
            timeout: 60000,
        });
        const result = JSON.parse(output);
        expect(result).toEqual({
            scenarios: 95,
            baseline: "@tranjs/core@1.1.0",
            passed: true,
        });
    }, 60000);
});
