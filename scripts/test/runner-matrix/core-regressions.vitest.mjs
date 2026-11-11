import { beforeAll, afterAll, test, vi } from 'vitest';
import cases from './core-regressions.cjs';
const { h } = cases;
beforeAll(h.setup);
afterAll(h.cleanup);
test('initializing integration session never falls through to production', cases.initializingSession);
test('object property and explicit mock names explain failures', () => cases.diagnosticLabels(vi.fn));
test('commit recovery consumes rollback injection and preserves containment', cases.recoveryInjection);
test('native broken savepoint recovery preserves finally and error chain', cases.brokenSavepointRecovery);
