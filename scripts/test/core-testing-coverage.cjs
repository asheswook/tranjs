const fs = require("node:fs");
const path = require("node:path");
const { createCoverageMap } = require("istanbul-lib-coverage");
const { createContext } = require("istanbul-lib-report");
const reports = require("istanbul-reports");

const root = path.resolve(__dirname, "../..");
const core = path.join(root, "packages/core");

// Each package runs only its own suites. Core enforces its pure production paths;
// testing enforces its own sources. Empty per-path Jest thresholds defer only
// manager.ts and internal bridge coverage to this combined check, not exemption.
// manager.ts is shared production/session code: neither run alone exercises both
// halves. Merge their Istanbul maps and enforce the ORIGINAL core-wide thresholds
// here, including every core source (not just the manager), without rerunning tests.
// Run after both package tests; the root test script must invoke this check.
const thresholds = require(path.join(core, "package.json")).jest.coverageThreshold.global;
const coverage = createCoverageMap({});
for (const name of ["core", "testing"]) {
    const file = path.join(root, "packages", name, "coverage/coverage-final.json");
    if (!fs.existsSync(file)) throw new Error(`Missing ${file}; run both package test suites first`);
    coverage.merge(JSON.parse(fs.readFileSync(file, "utf8")));
}
coverage.filter(file => file.startsWith(path.join(core, "src") + path.sep));
if (!coverage.files().length) throw new Error("No core source coverage was collected");

const context = createContext({ dir: path.join(core, "coverage/combined"), coverageMap: coverage });
for (const format of ["json", "json-summary", "text", "html"]) reports.create(format).execute(context);

const summary = coverage.getCoverageSummary();
for (const [metric, minimum] of Object.entries(thresholds)) {
    if (!Number.isFinite(summary[metric].pct) || summary[metric].pct < minimum) {
        console.error(`Combined core coverage for ${metric}: ${summary[metric].pct}% < ${minimum}%`);
        process.exitCode = 1;
    }
}
