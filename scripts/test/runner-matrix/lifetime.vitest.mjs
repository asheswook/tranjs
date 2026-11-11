import { beforeAll, afterAll, test, vi, onTestFinished } from 'vitest';
import cases from './lifetime-cases.cjs';
import { AsyncLocalStorage } from 'node:async_hooks';
const { h } = cases;
const clock = {
    install: () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }),
    flush: () => vi.runAllTimersAsync(),
    restore: () => vi.useRealTimers(),
};
let finish;
let finishMock;
beforeAll(h.setup);
afterAll(async () => {
    try {
        try { if (finish) await finish(); }
        finally { if (finishMock) await finishMock(); }
    }
    finally { await h.cleanup(); }
});
test('fake timer scheduled in A adopts B at flush (documented limitation)', () => cases.fakeTimerInsideB(clock));
test('native detached Promise retains closed A while B is active', cases.detachedInsideB);
test('mock A fake timer adopts real B at flush (documented limitation)', () => cases.fakeTimerInsideB(clock, 'mock'));
test('native detached mock Promise cannot reach restored real manager inside B', () => cases.mockDetached());
test('schedule detached mock Promise for real afterAll', async () => {
    finishMock = await cases.mockDetached({ afterAll: true });
});
test('onTestFinished registered inside helper: observe real dispatch context', () => h.testing.withTestTransaction(async a => {
    const observed = {};
    onTestFinished(async () => {
        try {
            await cases.completionWrite(observed)();
            await cases.verifyCompletion(observed, a);
        } finally { await h.pool.query(`DELETE FROM ${h.table} WHERE id=$1`, ['completion-hook']); }
    });
}));
test('schedule fake timer and native detached Promise for real afterAll', async () => {
    finish = await cases.scheduleAfterAll(clock);
});
test('user-bound onTestFinished retains closed A and rejects', () => h.testing.withTestTransaction(async a => {
    onTestFinished(AsyncLocalStorage.bind(async () => {
        h.assert.throws(() => h.testing.currentProbe(), /active.*session/i);
        await h.assert.rejects(h.core.transactional(() => h.assert.fail('bound closed callback ran'))(), /closed/i);
        h.assert.equal(a.records.length, 0);
        console.log('LIFETIME_BOUND_COMPLETION:owner=closed-A:rejected=1');
    }));
}));
