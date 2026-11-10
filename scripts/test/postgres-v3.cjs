#!/usr/bin/env node
// Requires npm install and npm run build. Never replace the installed v4 driver:
// copied workspace files resolve postgres to v3 even in native-import children.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const dependencies = path.join(root, "node_modules");

function link(source, target) {
    fs.symlinkSync(source, target, "junction");
}

function prepare(sandbox) {
    const alias = path.join(dependencies, "postgres-v3");
    const version = JSON.parse(fs.readFileSync(path.join(alias, "package.json"), "utf8")).version;
    assert(version.startsWith("3."), `Expected postgres-v3 3.x, found ${version}`);
    for (const file of ["package.json", "tsconfig.json"]) {
        fs.copyFileSync(path.join(root, file), path.join(sandbox, file));
    }
    for (const name of ["core", "testing", "postgres"]) {
        assert(fs.existsSync(path.join(root, "packages", name, "dist/index.js")),
            `Missing built @tranjs/${name}; run npm run build first`);
        const target = path.join(sandbox, "packages", name);
        fs.mkdirSync(target, { recursive: true });
        // Do not copy package-local node_modules: they could shadow the alias.
        for (const entry of ["package.json", "tsconfig.json", "src", "test", "dist"]) {
            const source = path.join(root, "packages", name, entry);
            if (fs.existsSync(source)) fs.cpSync(source, path.join(target, entry), { recursive: true });
        }
    }
    fs.cpSync(path.join(root, "scripts/test"), path.join(sandbox, "scripts/test"), { recursive: true });
    const modules = path.join(sandbox, "node_modules");
    fs.mkdirSync(modules);
    for (const entry of fs.readdirSync(dependencies)) {
        if (entry === "postgres" || entry === "@tranjs") continue;
        link(path.join(dependencies, entry), path.join(modules, entry));
    }
    link(alias, path.join(modules, "postgres"));
    fs.mkdirSync(path.join(modules, "@tranjs"));
    for (const name of ["core", "testing", "postgres"]) {
        link(path.join(sandbox, "packages", name), path.join(modules, "@tranjs", name));
    }
    const resolve = createRequire(path.join(sandbox, "package.json")).resolve;
    assert(fs.realpathSync(resolve("postgres")).startsWith(fs.realpathSync(alias) + path.sep),
        "Sandbox must resolve the actual v3 driver, not v4");
    return version;
}

async function run(command, args, options) {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    const forward = signal => child.kill(signal);
    const interrupt = () => forward("SIGINT");
    const terminate = () => forward("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    try {
        return await new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 1)));
        });
    } finally {
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", terminate);
    }
}

async function main() {
    const args = process.argv.slice(2);
    const compat = args[0] === "--compat";
    if (compat && args.length === 1) throw new Error("--compat requires a Node command");
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "tranjs-postgres-v3-"));
    try {
        const version = prepare(sandbox);
        console.log(`Testing actual postgres.js ${version} in an isolated workspace`);
        const env = { ...process.env, POSTGRES_MAJOR: "3" };
        if (compat) {
            return await run(args[1], [
                ...args.slice(2), "--unhandled-rejections=strict",
                path.join(sandbox, "scripts/test/postgres-node-compat.cjs"),
            ], { cwd: sandbox, env });
        }
        const packageRoot = path.join(sandbox, "packages/postgres");
        // Check the driver implementation itself against v3, not just consumers
        // of declarations (whose dependency declarations use skipLibCheck).
        const typecheck = await run(process.execPath, [
            path.join(dependencies, "typescript/bin/tsc"), "-p", path.join(packageRoot, "tsconfig.json"),
            "--noEmit", "--tsBuildInfoFile", path.join(sandbox, "postgres-v3.tsbuildinfo"),
        ], { cwd: sandbox, env });
        if (typecheck !== 0) return typecheck;
        const config = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).jest;
        // v3 intentionally skips v4-only features. Enforce its measured baseline
        // separately without weakening the ordinary v4 npm test thresholds.
        config.coverageThreshold = {
            global: { statements: 92.9, branches: 76.6, functions: 95.3, lines: 96.3 },
        };
        // Compile skipped v4-only tests against v4 declarations, while every
        // runtime import (including connection-loss.cjs) resolves actual v3.
        config.transform["^.+\\.ts$"][1].tsconfig.paths = {
            postgres: [path.join(dependencies, "postgres")],
        };
        const configFile = path.join(packageRoot, "jest.v3.json");
        fs.writeFileSync(configFile, JSON.stringify(config));
        return await run(process.execPath, [
            path.join(dependencies, "jest/bin/jest.js"),
            "--config", configFile, "--runInBand", ...args,
        ], { cwd: packageRoot, env });
    } finally {
        fs.rmSync(sandbox, { recursive: true, force: true });
    }
}

main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
