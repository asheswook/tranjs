// These are observations of real runner dispatch, NOT an isolation guarantee.
const h = require('./harness.cjs');
const { assert, core, testing, driver } = h;
const pid = async () => (await driver.ctx().query('SELECT pg_backend_pid() AS pid')).rows[0].pid;

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

// The callback is deliberately NOT bound. A fake-timer queue does not retain ALS.
function write(id, observation) {
    return async () => {
        let probe;
        try { probe = testing.currentProbe(); } catch (error) { observation.probeError = error; }
        observation.probe = probe;
        const save = async () => {
            observation.pid = await pid();
            await driver.ctx().query(`INSERT INTO ${h.table} VALUES ($1)`, [id]);
        };
        const tracked = probe ? probe.track(save) : save;
        await core.transactional(tracked)();
        if (probe) observation.info = probe.txOf(tracked);
    };
}

async function fakeTimerInsideB(clock, source = 'real') {
    const helper = source === 'mock' ? testing.mockTransactions : testing.withTestTransaction;
    const id = `${source}-fake-in-b`;
    const observed = {};
    let a;
    let done;
    clock.install();
    try {
        await helper(async probe => {
            a = probe;
            setTimeout(() => { done = write(id, observed)(); }, 1);
        });
        await testing.withTestTransaction(async b => {
            const backend = await core.transactional(pid)();
            await clock.flush();
            await done;
            assert.equal(observed.probe, b, 'runner no longer dispatches timers in the flush context');
            assert.notEqual(observed.probe, a);
            assert.equal(observed.pid, backend, 'late fake timer did not use B physical connection');
            assert.equal(observed.info.outcome, 'committed');
            assert.equal(a.records.length, 0, 'A unexpectedly acquired late evidence');
            assert.equal(b.records.length, 2, 'B must own both logical boundaries');
            assert.equal(await h.count(id), 0, 'B write became externally visible');
        });
        assert.equal(await h.count(id), 0);
        console.log(`LIFETIME_${source === 'mock' ? 'MOCK_' : ''}FAKE_TIMER_B:owner=B:backend=B:persisted=0:A-evidence=0`);
    } finally { clock.restore(); }
}

async function detachedInsideB() {
    const gate = deferred();
    let task;
    let bodies = 0;
    await testing.withTestTransaction(async a => {
        task = gate.promise.then(async () => {
            assert.throws(() => testing.currentProbe(), /active.*session/i);
            await assert.rejects(core.transactional(() => { bodies++; })(), /closed/i);
            assert.equal(a.records.length, 0);
        });
    });
    await testing.withTestTransaction(async b => {
        gate.resolve();
        await task;
        assert.equal(testing.currentProbe(), b);
        assert.equal(b.records.length, 0, 'native detached Promise rebound to B');
    });
    assert.equal(bodies, 0);
    console.log('LIFETIME_DETACHED_B:owner=closed-A:rejected=1:B-evidence=0');
}

// A separate registered real manager makes a closed Fake-manager -> real-manager
// escape observable, including a BEGIN that happens before an application body.
async function mockDetached({ afterAll = false } = {}) {
    const datasource = Symbol('mock-detached');
    let begins = 0;
    let bodies = 0;
    class CountingManager extends driver.PostgreSQLTransactionManager {
        async beginTransaction(options) {
            begins++;
            return super.beginTransaction(options);
        }
    }
    const manager = new CountingManager(h.pool);
    core.useTransactionManager(manager, datasource);
    const gate = deferred();
    let task;
    try {
        await testing.mockTransactions(async a => {
            task = gate.promise.then(async () => {
                assert.throws(() => testing.currentProbe(), /active.*session/i);
                for (const propagation of Object.values(core.Propagation)) {
                    await assert.rejects(core.transactional(async () => {
                        bodies++;
                        await driver.ctx(datasource).query('SELECT 1');
                    }, { datasource, propagation })(), /closed/i);
                }
                assert.equal(a.records.length, 0);
            });
        }, { datasource });
        assert.equal(core.getTransactionManager(datasource), manager, 'real manager was not restored after mock A');
        assert.equal(begins, 0, 'mock A started the registered real manager');
    } catch (error) {
        core.clearTransactionManager(datasource);
        throw error;
    }
    const finish = async () => {
        try {
            const before = begins;
            gate.resolve();
            await task;
            assert.equal(begins, before, 'late mock work began a registered real transaction');
            assert.equal(bodies, 0, 'late mock work ran an application callback');
        } finally {
            if (afterAll) await outsideAndCleanup();
        }
    };
    const outsideAndCleanup = async () => {
        try {
            const before = begins;
            assert.throws(() => testing.currentProbe(), /active.*session/i);
            const result = await core.transactional(async () => {
                const backend = await pidFor(datasource);
                const { rows } = await driver.ctx(datasource).query('SELECT 1 AS live');
                return { backend, live: rows[0].live };
            }, { datasource })();
            assert.equal(typeof result.backend, 'number');
            assert.equal(result.live, 1);
            assert.equal(begins, before + 1, 'legitimate outside caller did not start its own real transaction');
            console.log(`LIFETIME_MOCK_DETACHED_${afterAll ? 'AFTER_ALL' : 'B'}:owner=closed-A:rejected=all-propagations:real-BEGIN=0:callback=0:B-evidence=0:outside=real-SELECT`);
        } finally { core.clearTransactionManager(datasource); }
    };
    if (afterAll) return finish;
    try {
        await testing.withTestTransaction(async b => {
            assert.equal(begins, 1, 'B must own exactly one real physical BEGIN');
            await finish();
            assert.equal(testing.currentProbe(datasource), b);
            assert.equal(b.records.length, 0, 'late mock Promise rebound to B');
        }, { datasource });
        await outsideAndCleanup();
    } finally { core.clearTransactionManager(datasource); }
}

async function pidFor(datasource) {
    return (await driver.ctx(datasource).query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
}

// Schedule in a test's A, dispatch only from the real afterAll hook.
async function scheduleAfterAll(clock) {
    clock.install();
    const pending = [];
    for (const [source, helper] of [['real', testing.withTestTransaction], ['mock', testing.mockTransactions]]) {
        const gate = deferred();
        const observed = {};
        const item = { source, gate, observed, id: `${source}-fake-after-all` };
        pending.push(item);
        await helper(async a => {
            setTimeout(() => { item.timerTask = write(item.id, observed)(); }, 1);
            item.promiseTask = gate.promise.then(async () => {
                await assert.rejects(core.transactional(() => assert.fail('closed callback ran'))(), /closed/i);
                assert.equal(a.records.length, 0);
            });
        });
    }
    return async () => {
        try {
            for (const item of pending) item.gate.resolve();
            await Promise.all(pending.map(item => item.promiseTask));
            await clock.flush();
            for (const { timerTask, observed, id, source } of pending) {
                await timerTask;
                assert.equal(observed.probe, undefined);
                assert.match(observed.probeError.message, /active.*session/i);
                assert.equal(typeof observed.pid, 'number');
                assert.equal(await h.count(id), 1, 'production commit must be externally visible');
                console.log(`LIFETIME_${source === 'mock' ? 'MOCK_' : ''}AFTER_ALL:fake-owner=production:backend=physical:persisted=1:detached=closed-A-rejected`);
            }
        } finally {
            clock.restore();
            // Explicit cleanup: this case intentionally proves an escaped commit.
            for (const { id } of pending) await h.pool.query(`DELETE FROM ${h.table} WHERE id=$1`, [id]);
        }
    };
}

// Invoked by runner completion hooks without binding to the registration context.
function completionWrite(observed) { return write('completion-hook', observed); }
async function verifyCompletion(observed, a) {
    assert.equal(observed.probe, undefined, 'runner completion hook unexpectedly retained an active probe');
    assert.match(observed.probeError.message, /active.*session/i);
    assert.equal(typeof observed.pid, 'number');
    assert.equal(a.records.length, 0);
    assert.equal(await h.count('completion-hook'), 1);
    console.log('LIFETIME_COMPLETION:owner=production:backend=physical:persisted=1:A-evidence=0');
}

module.exports = { h, fakeTimerInsideB, detachedInsideB, mockDetached, scheduleAfterAll, completionWrite, verifyCompletion };
