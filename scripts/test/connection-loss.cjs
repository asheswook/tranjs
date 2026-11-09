// Run in an isolated Node process: an unhandled EventEmitter error must fail the
// process, not get intercepted by Jest. Requires the public packages to be built.
const assert = require("node:assert/strict");
const { setTimeout: delay } = require("node:timers/promises");
const { getTransactionManager, runInTransaction } = require("@tranjs/core");

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

async function main() {
    const [driver, scenario] = process.argv.slice(2);
    assert(["pg", "mysql2"].includes(driver));
    assert(["idle-query", "idle-commit", "active-query"].includes(scenario));
    let admin;
    let api;
    if (driver === "pg") {
        const pg = require("pg");
        const connectionString = process.env.PG_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
        admin = new pg.Client({ connectionString });
        await admin.connect();
        api = require("@tranjs/pg");
        api.usePostgreSQLClientPerTransaction({ connectionString });
    } else {
        const mysql = require("mysql2/promise");
        const config = { uri: process.env.MYSQL_URL ?? "mysql://root:root@localhost:3306/test" };
        admin = await mysql.createConnection(config);
        api = require("@tranjs/mysql2");
        api.useMySQLConnectionPerTransaction(config);
    }
    const manager = getTransactionManager();
    manager.setLogger({ error() {}, warn() {}, info() {}, debug() {} });
    const ready = deferred();
    const resume = deferred();
    let end = 0;
    let destroy = 0;
    let queryRejected = false;
    let commitRejected = false;
    let transaction;
    // Attach rejection handling immediately; do not add test error listeners to
    // the transaction connection (that would hide the production bug).
    const outcome = runInTransaction(async () => {
        transaction = manager.getCurrentTransaction();
        const originalEnd = transaction.end.bind(transaction);
        transaction.end = (...args) => { end++; return originalEnd(...args); };
        if (driver === "mysql2") {
            const originalDestroy = transaction.destroy.bind(transaction);
            transaction.destroy = () => { destroy++; return originalDestroy(); };
            const commit = transaction.commit.bind(transaction);
            transaction.commit = async () => {
                try { return await commit(); }
                catch (error) { commitRejected = true; throw error; }
            };
        } else {
            const query = transaction.query.bind(transaction);
            transaction.query = (...args) => {
                const result = query(...args);
                return args[0] === "COMMIT" ? result.catch(error => { commitRejected = true; throw error; }) : result;
            };
        }
        const result = await api.ctx().query(driver === "pg"
            ? "SELECT pg_backend_pid() AS id" : "SELECT CONNECTION_ID() AS id");
        const id = (driver === "pg" ? result.rows : result[0])[0].id;
        if (scenario === "active-query") {
            const pending = api.ctx().query(driver === "pg" ? "SELECT pg_sleep(30)" : "SELECT SLEEP(30)");
            ready.resolve(id);
            try { await pending; }
            catch (error) { queryRejected = true; throw error; }
        } else {
            ready.resolve(id);
            // The backend will be killed while the callback awaits non-DB work.
            await resume.promise;
            if (scenario === "idle-query") {
                try { await api.ctx().query("SELECT 1"); }
                catch (error) { queryRejected = true; throw error; }
            }
        }
    }).then(() => ({ rejected: false }), error => ({ rejected: true, error }));
    try {
        const id = await ready.promise;
        assert(Number.isInteger(id));
        if (scenario === "active-query") {
            // Verify the long query reached the server before killing it.
            let active = false;
            for (let attempt = 0; attempt < 100 && !active; attempt++) {
                const result = await admin.query(driver === "pg"
                    ? "SELECT query AS statement_text FROM pg_stat_activity WHERE pid = $1 AND state = 'active'"
                    : "SELECT INFO AS statement_text FROM information_schema.PROCESSLIST WHERE ID = ?", [id]);
                const rows = driver === "pg" ? result.rows : result[0];
                active = rows.some(row => /SELECT (pg_sleep|SLEEP)\(30\)/.test(row.statement_text ?? ""));
                if (!active) await delay(20);
            }
            assert(active, "long query never became active");
        }
        if (driver === "pg") await admin.query("SELECT pg_terminate_backend($1)", [id]);
        else await admin.query("KILL CONNECTION ?", [id]);
        // Allow the idle socket error to fire before resuming JavaScript work.
        await delay(100);
        resume.resolve();
        const result = await outcome;
        assert(result.rejected, "transaction unexpectedly committed on a dead connection");
        assert(result.error instanceof Error);
        assert.equal(end, 1);
        assert.equal(destroy, driver === "mysql2" ? 1 : 0);
        assert.equal(queryRejected, scenario !== "idle-commit");
        assert.equal(commitRejected, scenario === "idle-commit");
        // Listener retention must also be harmless for late socket events.
        const emitter = driver === "pg" ? transaction : transaction.connection;
        emitter.emit("error", new Error("late socket error after release"));
        await delay(20);
        console.log(JSON.stringify({ rejected: true, end, destroy, queryRejected, commitRejected }));
    } finally {
        await admin.end();
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
