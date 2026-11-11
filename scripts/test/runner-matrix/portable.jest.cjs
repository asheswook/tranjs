const h = require('./harness.cjs');
beforeAll(h.setup);
afterAll(h.cleanup);
test('portable serial', () => h.portable('serial'));
test.concurrent.each(['concurrent-one', 'concurrent-two'])('portable concurrent %s', id => h.portable(id));
