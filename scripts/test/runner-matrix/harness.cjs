const assert = require('node:assert/strict');
const { Pool } = require('pg');
const core = require('@tranjs/core');
const testing = require('@tranjs/testing');
const driver = require('@tranjs/pg');

const pool = new Pool({ connectionString: process.env.PG_URL || 'postgres://postgres:postgres@localhost:5432/postgres', max: 12 });
driver.usePostgreSQLTransactionManager(pool);
const table = `runner_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
const setup = () => pool.query(`CREATE TABLE ${table} (id text PRIMARY KEY)`);
const count = async id => Number((await pool.query(`SELECT count(*) FROM ${table} WHERE id=$1`, [id])).rows[0].count);
async function cleanup() {
    try {
        assert.equal(Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count), 0, 'test writes leaked');
    } finally {
        try { await pool.query(`DROP TABLE IF EXISTS ${table}`); }
        finally { await pool.end(); }
    }
}
async function exercise(probe, id) {
    assert.equal(testing.transactions(), probe);
    const save = probe.track(async function save() {
        await driver.ctx().query(`INSERT INTO ${table} VALUES ($1)`, [id]);
        return (await driver.ctx().query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    });
    const first = await core.transactional(save)();
    assert.equal(probe.txOf(save).outcome, 'committed');
    assert.equal(await count(id), 0, 'logical commit became visible outside the test transaction');
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(testing.transactions(), probe, 'session lost after an await');
    const second = await core.transactional(async () => (await driver.ctx().query('SELECT pg_backend_pid() AS pid')).rows[0].pid)();
    assert.equal(first, second, 'test did not retain its physical connection');
    return first;
}
const portable = id => testing.withTestTransaction(probe => exercise(probe, id));
module.exports = { assert, core, testing, driver, pool, table, setup, cleanup, count, exercise, portable };
