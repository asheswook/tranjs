require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { Injectable, Inject } = require('@nestjs/common');
const h = require('./harness.cjs');
class Repository {
    async save(id) {
        await h.driver.ctx().query(`INSERT INTO ${h.table} VALUES ($1)`, [id]);
        return (await h.driver.ctx().query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    }
}
Injectable()(Repository);
class Service {
    constructor(repository) { this.repository = repository; }
    async save(id) { return this.repository.save(id); }
}
Injectable()(Service);
Inject(Repository)(Service, undefined, 0);
Object.defineProperty(Service.prototype, 'save', h.core.Transactional()(Service.prototype, 'save', Object.getOwnPropertyDescriptor(Service.prototype, 'save')));
let moduleRef;
beforeAll(async () => {
    await h.setup();
    moduleRef = await Test.createTestingModule({ providers: [Repository, Service] }).compile();
});
afterAll(async () => { try { await moduleRef.close(); } finally { await h.cleanup(); } });
test('Nest DI joins portable scope across awaits', () => h.testing.withTestTransaction(async probe => {
    const repository = moduleRef.get(Repository);
    const original = repository.save;
    h.assert.equal(h.testing.currentProbe(), probe);
    repository.save = probe.track(original);
    try {
        const service = moduleRef.get(Service);
        const first = await service.save('nest-one');
        await Promise.resolve();
        h.assert.equal(await service.save('nest-two'), first);
        h.assert.equal(await h.count('nest-one'), 0);
    } finally { repository.save = original; }
}));
test('Nest writes are rolled back', async () => {
    h.assert.equal(await h.count('nest-one'), 0);
    h.assert.equal(await h.count('nest-two'), 0);
});
