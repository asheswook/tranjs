const h = require('./harness.cjs');
const cases = require('./core-regressions.cjs');
beforeAll(h.setup);
afterAll(h.cleanup);
test('initializing integration session never falls through to production', cases.initializingSession);
test('object property and explicit mock names explain failures', () => cases.diagnosticLabels(jest.fn));
test('commit recovery consumes rollback injection and preserves containment', cases.recoveryInjection);
test('native broken savepoint recovery preserves finally and error chain', cases.brokenSavepointRecovery);
