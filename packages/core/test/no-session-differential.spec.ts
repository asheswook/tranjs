import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

describe("no-session production fidelity", () => {
    it.each([
        ["1.1.0", 89, 8],
        ["1.2.0", 91, 6],
    ])("pins @tranjs/core@%s: %i identical probes and %i intended differences", (version, identical, intended) => {
        const output = execFileSync(process.execPath, [resolve(__dirname, "../../../scripts/test/core-no-session-differential.cjs"), version], {
            cwd: resolve(__dirname, "../../.."),
            encoding: "utf8",
            stdio: "pipe",
            timeout: 60000,
        });
        const result = JSON.parse(output);
        expect(result).toEqual({
            scenarios: 97,
            baseline: `@tranjs/core@${version}`,
            identical,
            intended,
            passed: true,
        });
    }, 60000);
});
