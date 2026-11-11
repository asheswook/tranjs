const h = require('./harness.cjs');
const { Pool } = require('pg');
const { assert, core, testing, driver } = h;

async function initializingSession() {
    const pool = new Pool({ connectionString: process.env.PG_URL || 'postgres://postgres:postgres@localhost:5432/postgres', max: 4 });
    const datasource = Symbol('initializing-session');
    const table = `${h.table}_initializing`;
    let checked = false;
    let bodies = 0;
    let physicalBegins = 0;
    pool.on('connect', client => {
        const query = client.query;
        client.query = async function (...args) {
            const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
            if (sql?.startsWith('BEGIN')) {
                physicalBegins++;
                if (!checked) {
                    checked = true;
                    // This executes in the helper's initializing ALS, while its
                    // hidden BEGIN has not even reached PostgreSQL yet.
                    for (const propagation of Object.values(core.Propagation)) {
                        await assert.rejects(core.transactional(async () => {
                            bodies++;
                            await pool.query(`INSERT INTO ${table} VALUES (1)`);
                        }, { datasource, propagation })(), /initializ/i);
                    }
                }
            }
            return Reflect.apply(query, this, args);
        };
    });
    driver.usePostgreSQLTransactionManager(pool, datasource);
    try {
        await pool.query(`CREATE TABLE ${table} (id integer)`);
        await testing.withTestTransaction(async () => {
            await core.transactional(() => driver.ctx(datasource).query(`INSERT INTO ${table} VALUES (2)`), { datasource })();
        }, { datasource });
        assert.equal(checked, true);
        assert.equal(bodies, 0, 'initializing sessions admitted application work');
        assert.equal(physicalBegins, 1, 'initializing session escaped into a physical owner');
        assert.deepEqual((await pool.query(`SELECT * FROM ${table}`)).rows, []);
    } finally {
        core.clearTransactionManager(datasource);
        try { await pool.query(`DROP TABLE IF EXISTS ${table}`); }
        finally { await pool.end(); }
    }
}

async function diagnosticLabels(mock) {
    await testing.withTestTransaction(async tx => {
        const accounts = tx.track({ debit: mock().mockName('accounts.debit'), credit: mock() });
        await core.transactional(() => accounts.debit())();
        accounts.credit();
        assert.throws(() => testing.assertSameTransaction(accounts.debit, accounts.credit), error => {
            assert.match(error.message, /Received: accounts\.debit → tx#1 \(REQUIRED, committed\), event 1/);
            assert.match(error.message, /Other: credit → outside transaction, event 3/);
            assert.doesNotMatch(error.message, /mockConstructor|spy →/);
            return true;
        });
    });
}

async function recoveryInjection() {
    const commit = new Error('selected commit failure');
    const rollback = new Error('selected recovery rollback failure');
    const later = new Error('unrelated application failure');
    let rollbackHooks = 0;
    let commitHooks = 0;
    await testing.withTestTransaction(async tx => {
        const save = tx.track(async function save() {
            await driver.ctx().query(`INSERT INTO ${h.table} VALUES ('recovery')`);
        });
        tx.failNext('commit', { containing: save, error: commit });
        tx.failNext('rollback', { error: rollback });
        await core.transactional(() => {})(); // Selectors must survive unrelated success.
        await assert.rejects(core.transactional(async () => {
            core.afterCommit(() => { commitHooks++; });
            core.afterRollback(() => { rollbackHooks++; });
            await save();
        })(), error => {
            assert.equal(error.name, 'TransactionSystemError');
            assert.equal(error.applicationError, commit);
            assert.equal(error.cause, rollback);
            return true;
        });
        assert.equal(rollbackHooks, 1);
        assert.equal(commitHooks, 0);
        assert.equal(await core.transactional(async () => Number((await driver.ctx().query(`SELECT count(*) FROM ${h.table}`)).rows[0].count))(), 0);
        await assert.rejects(core.transactional(() => { throw later; })(), error => error === later);
    });
    assert.equal(await h.count('recovery'), 0);
}

async function brokenSavepointRecovery() {
    const datasource = Symbol('broken-savepoint-recovery');
    const application = new Error('matrix application failure');
    const recovery = new Error('matrix native savepoint recovery failure');
    const physical = new Error('matrix native final rollback failure');
    let savepointRollbacks = 0;
    let physicalRollbacks = 0;
    let callbackFinally = false;
    let applicationFinally = false;
    let logicalFailure;
    class BrokenRecoveryManager extends driver.PostgreSQLTransactionManager {
        async rollbackToSavepoint(tx, name) {
            await super.rollbackToSavepoint(tx, name); // Real SQL must happen first.
            if (++savepointRollbacks === 1) throw recovery;
        }
        async rollbackTransaction(tx) {
            await super.rollbackTransaction(tx); // Never leave the connection dirty.
            physicalRollbacks++;
            throw physical;
        }
    }
    const manager = new BrokenRecoveryManager(h.pool);
    manager.setLogger({ error() {}, warn() {}, log() {}, debug() {} });
    core.useTransactionManager(manager, datasource);
    try {
        await assert.rejects(testing.withTestTransaction(async probe => {
            try {
                await core.transactional(async () => {
                    try {
                        await driver.ctx(datasource).query(`INSERT INTO ${h.table} VALUES ('broken-recovery')`);
                        throw application;
                    } finally { applicationFinally = true; }
                }, { datasource })();
            } catch (error) {
                logicalFailure = error;
                assert.equal(error.name, 'TransactionSystemError');
                assert.equal(error.applicationError, application);
                assert.equal(error.cause, recovery);
                assert.equal(probe.records[0].outcome, 'rolled-back');
                await assert.rejects(core.transactional(() => assert.fail('broken session admitted work'), { datasource })(), /broken|aborted|recovery/i);
                throw error;
            } finally { callbackFinally = true; }
        }, { datasource }), error => {
            assert.equal(error.name, 'TransactionSystemError');
            assert.equal(error.cause, physical);
            assert.equal(error.applicationError, logicalFailure);
            assert.equal(error.applicationError.applicationError, application);
            assert.equal(error.applicationError.cause, recovery);
            return true;
        });
        assert.equal(applicationFinally, true);
        assert.equal(callbackFinally, true);
        assert.equal(savepointRollbacks, 1);
        assert.equal(physicalRollbacks, 1);
        assert.equal(await h.count('broken-recovery'), 0);
        console.log('BROKEN_RECOVERY:callback-finally=1:native-savepoint-rollback=1:native-final-rollback=1:error-chain=physical>recovery>application:persisted=0');
    } finally { core.clearTransactionManager(datasource); }
}

module.exports = { h, initializingSession, diagnosticLabels, recoveryInjection, brokenSavepointRecovery };
