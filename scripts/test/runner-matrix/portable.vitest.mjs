import { beforeAll, afterAll, test, describe } from 'vitest';
import h from './harness.cjs';
beforeAll(h.setup);
afterAll(h.cleanup);
test('portable serial', () => h.portable('serial'));
test.concurrent.each(['test-one', 'test-two'])('portable concurrent %s', id => h.portable(id));
describe.concurrent('portable describe.concurrent', () => {
    test('one', () => h.portable('describe-one'));
    test('two', () => h.portable('describe-two'));
});
