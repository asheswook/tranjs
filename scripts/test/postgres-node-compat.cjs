// Exercise the shipped CommonJS output, not TypeScript/Jest transforms.
const assert = require("node:assert/strict");
const Module = require("node:module");
const load = Module._load;

// Also reject synchronous loading on runtimes where require(ESM) is enabled.
Module._load = function (request, ...args) {
    assert(request !== "postgres" && !request.startsWith("postgres/"),
        "postgres must be loaded with native dynamic import, not require");
    return load.call(this, request, ...args);
};

async function main() {
    const { version } = JSON.parse(require("node:fs").readFileSync(
        require("node:path").resolve(__dirname, "../../node_modules/postgres/package.json"), "utf8"));
    if (process.env.POSTGRES_MAJOR) {
        assert.equal(version.split(".")[0], process.env.POSTGRES_MAJOR,
            "Native imports must exercise the requested postgres.js major");
    }
    const { runInTransaction } = require("../../packages/core/dist");
    const {
        ctx,
        usePostgresTransactionManager,
        usePostgresConnectionPerTransaction,
    } = require("../../packages/postgres/dist");
    // A CommonJS consumer can supply its own pool without require(ESM).
    const { default: postgres } = await import("postgres");
    const url = process.env.PG_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
    const sql = postgres(url, { max: 1, onnotice: false });
    const table = `tranjs_node_compat_${process.pid}_${Date.now()}`;
    let created = false;
    try {
        // A uniquely named scratch table must be visible across per-tx connections.
        await sql.unsafe(`CREATE TABLE ${table} (id integer PRIMARY KEY)`);
        created = true;
        for (const [mode, base] of [["pool", 0], ["per-tx", 3]]) {
            if (mode === "pool") usePostgresTransactionManager(sql);
            else usePostgresConnectionPerTransaction(url);

            const committed = base + 1;
            await runInTransaction(async () => {
                const [{ pid }] = await ctx()`SELECT pg_backend_pid() AS pid`;
                assert(Number.isInteger(pid));
                const rows = await ctx().unsafe(
                    `INSERT INTO ${table} VALUES ($1) RETURNING pg_backend_pid() AS pid`, [committed]);
                assert.equal(rows[0].pid, pid, `${mode}: transaction changed connections`);
            });
            assert.equal((await sql.unsafe(`SELECT id FROM ${table} WHERE id = $1`, [committed])).length, 1);

            const failure = new Error(`${mode}: intentional rollback`);
            await assert.rejects(runInTransaction(async () => {
                await ctx().unsafe(`INSERT INTO ${table} VALUES ($1)`, [base + 2]);
                throw failure;
            }), error => error === failure);
            assert.equal((await sql.unsafe(`SELECT id FROM ${table} WHERE id = $1`, [base + 2])).length, 0);

            // Reuse after rollback must neither leak transaction state nor a reservation.
            await runInTransaction(async () => {
                const rows = await ctx().unsafe(`SELECT id FROM ${table} WHERE id = $1`, [committed]);
                assert.equal(rows[0].id, committed);
                await ctx().unsafe(`INSERT INTO ${table} VALUES ($1)`, [base + 3]);
            });
        }
        assert.deepEqual((await sql.unsafe(`SELECT id FROM ${table} ORDER BY id`)).map(row => row.id), [1, 3, 4, 6]);
        console.log(`${process.version} ${process.execArgv.join(" ")} postgres.js ${version}: built CJS pool + per-tx commit/rollback passed`);
    } finally {
        try {
            if (created) await sql.unsafe(`DROP TABLE ${table}`);
        } finally {
            await sql.end();
        }
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => { Module._load = load; });
