const cases = require('./lifetime-cases.cjs');
const { AsyncLocalStorage } = require('node:async_hooks');
const { h } = cases;
const clock = {
    install: () => jest.useFakeTimers({ doNotFake: ['Date', 'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate'] }),
    flush: () => jest.runAllTimersAsync(),
    restore: () => jest.useRealTimers(),
};
let finish;
let finishMock;
let completion;
let captured;
beforeAll(h.setup);
afterEach(async () => {
    if (captured) {
        const callback = captured;
        captured = undefined;
        await callback();
    }
    if (!completion) return;
    const { observed, a } = completion;
    completion = undefined;
    try {
        await cases.completionWrite(observed)();
        await cases.verifyCompletion(observed, a);
    } finally { await h.pool.query(`DELETE FROM ${h.table} WHERE id=$1`, ['completion-hook']); }
});
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
test('pre-registered afterEach does not inherit the helper callback context', () => h.testing.withTestTransaction(async a => {
    completion = { observed: {}, a };
}));
test('user-bound afterEach callback retains closed A and rejects', () => h.testing.withTestTransaction(async a => {
    captured = AsyncLocalStorage.bind(async () => {
        h.assert.throws(() => h.testing.currentProbe(), { message: "currentProbe() requires an active transaction test callback" });
        await h.assert.rejects(h.core.transactional(() => h.assert.fail('bound closed callback ran'))(), { message: "The test transaction has finished or could not be restored" });
        h.assert.equal(a.records.length, 0);
        console.log('LIFETIME_BOUND_COMPLETION:owner=closed-A:rejected=1');
    });
}));
test('schedule fake timer and native detached Promise for real afterAll', async () => {
    finish = await cases.scheduleAfterAll(clock);
});
