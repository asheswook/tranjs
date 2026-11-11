// Jest reports nested hook registration as a test failure (not a catchable throw).
const h = require('./harness.cjs');
let called = false;
beforeAll(h.setup);
afterAll(async () => {
    try {
        h.assert.equal(called, false, 'Jest unexpectedly installed the nested hook');
        console.log('LIFETIME_JEST_NESTED_AFTER_EACH:registration=rejected:callback=not-installed');
    } finally { await h.cleanup(); }
});
test('Jest forbids afterEach registration inside withTestTransaction', () => h.testing.withTestTransaction(async () => {
    afterEach(() => { called = true; });
}));
