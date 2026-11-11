import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

describe("no-session production fidelity", () => {
    it("preserves all 86 @tranjs/core@1.1.0 probes and exactly guards retained contexts/connections after commit or rollback", () => {
        const output = execFileSync(process.execPath, [resolve(__dirname, "../../../scripts/test/core-no-session-differential.cjs")], {
            cwd: resolve(__dirname, "../../.."),
            encoding: "utf8",
            stdio: "pipe",
            timeout: 60000,
        });
        const result = JSON.parse(output);
        expect(result).toEqual({
            scenarios: 88,
            baseline: "@tranjs/core@1.1.0",
            passed: true,
        });
    }, 60000);
});
