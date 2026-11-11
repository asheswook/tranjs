#!/usr/bin/env node
// Run after a clean build of core, testing, and every driver. No workspace links.
// Requires a real PostgreSQL server (PG_URL, or the usual local test database).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const packages = ["core", "testing", "pg", "mysql2", "postgres"];
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, cwd) {
    const result = spawnSync(command, args, {
        cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, NODE_PATH: "" },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
    }
    return result.stdout.trim();
}

// These functions are emitted into the actual consumer so both native import
// and require resolve packages from its node_modules, never from this script.
async function runtimeChecks() {
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const path = require("node:path");
    const { createRequire } = require("node:module");
    let identities = 0;
    const same = (a, b, message) => { assert.equal(a, b, message); identities++; };
    const core = require("@tranjs/core");
    const coreOnly = Object.keys(require.cache);
    const forbidden = coreOnly.filter(file =>
        /[/\\]@tranjs[/\\]testing[/\\]/.test(file) ||
        /[/\\](?:testing|probe|fake|matchers?|metadata|jest|vitest)(?:[/\\]|\.[cm]?js$)/.test(file));
    assert.deepEqual(forbidden, [], "Core main must not load testing/probe/fake/matcher/runner code");
    // Cache isolation is observable; do not claim this proves ALS allocation.
    const importedCore = await import("@tranjs/core");
    const coreRoot = path.dirname(path.dirname(require.resolve("@tranjs/core")));
    const main = require(path.resolve(coreRoot, JSON.parse(fs.readFileSync(path.join(coreRoot, "package.json"))).main));
    const legacy = require("@tranjs/core/dist/asyncLocal");
    const importedLegacy = await import("@tranjs/core/dist/asyncLocal");
    const bridge = require("@tranjs/core/internal/testing-bridge");
    const importedBridge = await import("@tranjs/core/internal/testing-bridge");
    for (const entry of [main, importedCore]) {
        for (const key of ["AsyncLocal", "PlatformTransactionManager", "getTransactionManager", "useTransactionManager", "transactional"]) {
            assert.equal(typeof core[key], "function", `Missing core export ${key}`);
            same(entry[key], core[key], `${key} must have one core identity`);
        }
    }
    for (const entry of [legacy, importedLegacy, bridge, importedBridge]) same(entry.AsyncLocal, core.AsyncLocal);
    assert.equal("runInTransaction" in core, false);
    assert.equal(bridge.TESTING_BRIDGE_VERSION, 1);

    const drivers = {};
    for (const name of ["pg", "mysql2", "postgres"]) {
        drivers[name] = require(`@tranjs/${name}`);
        const fromDriver = createRequire(require.resolve(`@tranjs/${name}`));
        same(fromDriver.resolve("@tranjs/core"), require.resolve("@tranjs/core"), `${name} must resolve installed core`);
        same(fromDriver("@tranjs/core").PlatformTransactionManager, core.PlatformTransactionManager);
    }
    assert(!Object.keys(require.cache).some(file => /[/\\]@tranjs[/\\]testing[/\\]/.test(file)),
        "Drivers must not load @tranjs/testing");
    const testing = require("@tranjs/testing");
    const importedTesting = await import("@tranjs/testing");
    // A dual build may have distinct functions; shared state is checked below.
    for (const entry of [testing, importedTesting]) {
        for (const key of ["withTestConnection", "withTestTransaction", "currentProbe"]) assert.equal(typeof entry[key], "function");
    }

    const { Pool } = require("pg");
    const pool = new Pool({
        connectionString: process.env.PG_URL || "postgres://postgres:postgres@localhost:5432/postgres",
        max: 3, connectionTimeoutMillis: 10000,
    });
    const datasource = Symbol("packed-consumer");
    const table = `tranjs_packed_${process.pid}_${Date.now()}`;
    const manager = new drivers.pg.PostgreSQLTransactionManager(pool);
    core.useTransactionManager(manager, datasource);
    same(importedCore.getTransactionManager(datasource), manager);
    // Exercise both directions, not just the convenient CJS-first direction.
    const directions = [[testing, importedTesting, core], [importedTesting, testing, importedCore]];
    let created = false;
    try {
        await pool.query(`CREATE TABLE ${table} (id integer PRIMARY KEY)`);
        created = true;
        for (const [sessionApi, otherApi, appCore] of directions) {
            await sessionApi.withTestTransaction(async probe => {
                same(otherApi.currentProbe(datasource), probe, "Import and require must share the live probe");
                same(sessionApi.currentProbe(), probe);
                assert.throws(() => drivers.pg.ctx(datasource), /context|transaction/i);
                await otherApi.withTestConnection(async db => {
                    await db.query(`INSERT INTO ${table} VALUES ($1)`, [1]);
                    assert.throws(() => drivers.pg.ctx(datasource), /context|transaction/i);
                }, { datasource });
                assert.equal(probe.records.length, 0, "withTestConnection must not record a logical transaction");
                const save = probe.track(async function save(id) {
                    const db = drivers.pg.ctx(datasource);
                    assert(manager.getCurrentTransaction());
                    await db.query(`INSERT INTO ${table} VALUES ($1)`, [id]);
                    return (await db.query(`SELECT id FROM ${table} ORDER BY id`)).rows.map(row => row.id);
                });
                const application = callback => appCore.transactional(callback, { datasource })();
                assert.deepEqual(await application(() => save(2)), [1, 2]);
                assert.equal(probe.txOf(save).outcome, "committed");
                assert.equal(probe.records.length, 1);
                const failing = probe.track(async () => {
                    await drivers.pg.ctx(datasource).query(`INSERT INTO ${table} VALUES (3)`);
                });
                const failure = new Error("packed injected commit failure");
                probe.failNext("commit", { containing: failing, error: failure });
                await assert.rejects(application(failing), error => error === failure);
                assert.equal(probe.txOf(failing).outcome, "rolled-back");
                await application(async () => {
                    assert.deepEqual((await drivers.pg.ctx(datasource).query(`SELECT id FROM ${table} ORDER BY id`)).rows,
                        [{ id: 1 }, { id: 2 }]);
                });
                assert.deepEqual((await pool.query(`SELECT * FROM ${table}`)).rows, [], "No physical commit during session");
            }, { datasource });
            assert.deepEqual((await pool.query(`SELECT * FROM ${table}`)).rows, [], "Session must physically roll back");
            assert.throws(() => otherApi.currentProbe(datasource), { message: "currentProbe() requires an active transaction test callback" });
        }
    } finally {
        core.clearTransactionManager(datasource);
        try { if (created) await pool.query(`DROP TABLE ${table}`); }
        finally { await pool.end(); }
    }
    console.log(JSON.stringify({ identities, mixed: directions.length, coreCachedModules: coreOnly.length }));
}

async function mismatchChecks() {
    const assert = require("node:assert/strict");
    const core = require("@tranjs/core");
    let begins = 0;
    // Construct before loading testing: the bridge must retain this manager's
    // protected begin hook, but must never get far enough to invoke it.
    class BeginSentinel extends core.PlatformTransactionManager {
        constructor() { super(); }
        async beginTransaction() { begins++; throw new Error("BEGIN SENTINEL: transaction opened"); }
        async commitTransaction() {}
        async rollbackTransaction() {}
    }
    const datasource = Symbol("mismatch");
    core.useTransactionManager(new BeginSentinel(), datasource);
    try {
        let failure;
        try {
            if (process.argv[2] === "import") await import("@tranjs/testing");
            else require("@tranjs/testing");
        } catch (error) { failure = error; }
        assert.equal(begins, 0, "A mismatched package must not open a transaction");
        assert(failure, "@tranjs/testing must reject the mismatch at module load, not at session entry");
        assert.match(String(failure), /version|protocol|incompatib|mismatch/i);
        assert.match(String(failure), /core|bridge/i);
    } finally {
        core.clearTransactionManager(datasource);
    }
    console.log(JSON.stringify({ mismatch: 1, begins }));
}

const types = `import { withTestConnection, type TestOptions } from "@tranjs/testing";
import type { TestConnection as PgTestConnection } from "@tranjs/pg";
import type { TestConnection as Mysql2TestConnection } from "@tranjs/mysql2";
import type { TestConnection as PostgresTestConnection } from "@tranjs/postgres";

export const pgTestConnection = <R>(fn: (db: PgTestConnection) => R, options?: TestOptions) => withTestConnection(fn, options);
export const mysqlTestConnection = <R>(fn: (db: Mysql2TestConnection) => R, options?: TestOptions) => withTestConnection(fn, options);
export const postgresTestConnection = <R>(fn: (db: PostgresTestConnection) => R, options?: TestOptions) => withTestConnection(fn, options);
export const pgResult = () => pgTestConnection(async db => (await db.query("SELECT $1::int AS id", [1])).rows);
export const mysqlResult = () => mysqlTestConnection(async db => {
    await db.query("SELECT ? AS id", [1]);
    return db.execute("SELECT ? AS id", [1]);
});
export const postgresResult = () => postgresTestConnection(async db => {
    await db.unsafe("SELECT $1::int AS id", [1]);
    return db\`SELECT \${1}::int AS id\`;
});
export const restrictedTypes = () => {
    void pgTestConnection(db => {
        // @ts-expect-error Native lifecycle is not exposed.
        db.release();
        // @ts-expect-error Config objects are not part of the withTestConnection contract.
        db.query({ text: "SELECT 1" });
        // @ts-expect-error Callback queries are not part of the withTestConnection contract.
        db.query("SELECT 1", () => {});
        return db.query<{ id: number }>("SELECT 1 AS id");
    });
    void mysqlTestConnection(db => {
        // @ts-expect-error Native internals are not exposed.
        db.connection;
        // @ts-expect-error Native lifecycle is not exposed.
        db.commit();
        return db.execute("SELECT ? AS id", [1]);
    });
    void postgresTestConnection(db => {
        // @ts-expect-error Native connection helpers are not exposed.
        db.reserve();
        // @ts-expect-error Query modifiers are not exposed on plain promises.
        db\`SELECT 1\`.values();
        // @ts-expect-error Native unsafe options are not supported.
        db.unsafe("SELECT 1", [], { prepare: false });
        return db\`SELECT 1\`;
    });
};
`;

async function main() {
    const sourceManifests = Object.fromEntries(packages.map(name => [
        name, JSON.parse(fs.readFileSync(path.join(root, "packages", name, "package.json"))),
    ]));
    for (const name of packages) {
        assert(fs.existsSync(path.join(root, "packages", name, "dist/index.js")),
            `Missing built @tranjs/${name}; finish the clean package build before running this script`);
    }
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "tranjs-packed-"));
    let succeeded = false;
    console.log(`Packed consumer: ${sandbox}`);
    try {
        const consumer = path.join(sandbox, "consumer");
        fs.mkdirSync(consumer);
        fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "tranjs-packed-check", version: "1.0.0", private: true }));
        const tarballs = [];
        for (const name of packages) {
            const output = run(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", sandbox], path.join(root, "packages", name));
            const [packed] = JSON.parse(output);
            assert.equal(packed.name, `@tranjs/${name}`);
            assert(packed.files.some(file => file.path === "dist/index.js"), `Missing packed runtime for ${name}`);
            assert(packed.files.some(file => file.path === "dist/index.d.ts"), `Missing packed declarations for ${name}`);
            assert.equal(packed.version, sourceManifests[name].version);
            tarballs.push(path.join(sandbox, packed.filename));
        }
        run(npm, ["install", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", ...tarballs, "@types/node@^22"], consumer);
        const consumerRequire = createRequire(path.join(consumer, "package.json"));
        const modules = path.join(consumer, "node_modules");
        for (const name of packages) {
            const installed = path.join(modules, "@tranjs", name);
            assert(!fs.lstatSync(installed).isSymbolicLink(), `@tranjs/${name} must not be a workspace symlink`);
            assert(fs.realpathSync(consumerRequire.resolve(`@tranjs/${name}`)).startsWith(fs.realpathSync(modules) + path.sep));
            const installedManifest = JSON.parse(fs.readFileSync(path.join(installed, "package.json")));
            assert.equal(installedManifest.version, sourceManifests[name].version, `Installed @tranjs/${name} version must match source`);
        }
        const coreManifest = JSON.parse(fs.readFileSync(path.join(modules, "@tranjs/core/package.json")));
        assert(!coreManifest.dependencies?.["@tranjs/testing"] && !coreManifest.peerDependencies?.["@tranjs/testing"]);
        const testingManifest = JSON.parse(fs.readFileSync(path.join(modules, "@tranjs/testing/package.json")));
        assert.equal(testingManifest.peerDependencies["@tranjs/core"], sourceManifests.testing.peerDependencies["@tranjs/core"]);
        assert(!testingManifest.peerDependenciesMeta?.["@tranjs/core"]?.optional, "Core peer must be required");

        const runtimeFile = path.join(consumer, "runtime.cjs");
        const mismatchFile = path.join(consumer, "mismatch.cjs");
        const emit = fn => `(${fn.toString()})().catch(error => { console.error(error); process.exitCode = 1; });\n`;
        fs.writeFileSync(runtimeFile, emit(runtimeChecks));
        fs.writeFileSync(mismatchFile, emit(mismatchChecks));
        const runtime = JSON.parse(run(process.execPath, ["--unhandled-rejections=strict", runtimeFile], consumer));

        const bridgeFile = consumerRequire.resolve("@tranjs/core/internal/testing-bridge");
        const original = fs.readFileSync(bridgeFile, "utf8");
        let mismatches = 0;
        try {
            const assignment = /(exports\.TESTING_BRIDGE_VERSION\s*=\s*)1(\s*;)/g;
            let changes = 0;
            const mutated = original.replace(assignment, (_match, prefix, suffix) => {
                changes++;
                return prefix + "999" + suffix;
            });
            assert.equal(changes, 1, `Expected exactly one emitted TESTING_BRIDGE_VERSION assignment in ${bridgeFile}`);
            fs.writeFileSync(bridgeFile, mutated);
            for (const loader of ["require", "import"]) {
                const result = JSON.parse(run(process.execPath, ["--unhandled-rejections=strict", mismatchFile, loader], consumer));
                assert.equal(result.begins, 0);
                mismatches += result.mismatch;
            }
        } finally {
            fs.writeFileSync(bridgeFile, original);
        }

        fs.writeFileSync(path.join(consumer, "withTestConnection-types.ts"), types);
        fs.writeFileSync(path.join(consumer, "tsconfig.json"), JSON.stringify({
            compilerOptions: { target: "ES2022", module: "Node16", moduleResolution: "Node16", strict: true, skipLibCheck: false, noEmit: true },
            files: ["withTestConnection-types.ts"],
        }));
        run(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "-p", path.join(consumer, "tsconfig.json")], consumer);
        console.log(`Packed consumer passed: packages=${packages.length} identities=${runtime.identities} mixed=${runtime.mixed} mismatches=${mismatches} types=1 core-cache=${runtime.coreCachedModules}`);
        succeeded = true;
    } finally {
        if (!succeeded || process.env.KEEP_PACKED_SANDBOX === "1") {
            console.log(`Retained packed consumer sandbox: ${sandbox}`);
        } else {
            fs.rmSync(sandbox, { recursive: true, force: true });
        }
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
