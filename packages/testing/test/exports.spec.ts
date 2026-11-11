import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// Use Node, not Jest's resolver or transformed source, to exercise package exports.
function runNode(script: string, esm = false): void {
    execFileSync(process.execPath, [...(esm ? ["--input-type=module"] : []), "-e", script], {
        cwd: resolve(__dirname, ".."),
        encoding: "utf8",
        stdio: "pipe",
    });
}

describe("built package exports", () => {
    const managerScript = `
        const assert = require('node:assert/strict');
        const core = require('@tranjs/core');
        const testing = require('@tranjs/testing');
        let rollbacks = 0;
        let releases = 0;
        class Manager extends core.PlatformTransactionManager {
            async beginTransaction() { return { transaction: {}, metadata: { driverName: 'promise-test' } }; }
            async commitTransaction() {}
            async rollbackTransaction() { rollbacks++; }
            async releaseTransaction() { releases++; }
            async createSavepoint() {}
            async rollbackToSavepoint() {}
            async releaseSavepoint() {}
        }
        core.useTransactionManager(new Manager());
        const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    `;

    it("preserves native unhandled rejection behavior in production, mock and integration modes", () => {
        runNode(managerScript + `
            const unhandled = [];
            process.on('unhandledRejection', error => { unhandled.push(error); });
            (async () => {
                for (const mode of ['production', 'mock', 'integration']) {
                    const expected = [];
                    const body = async () => {
                        const direct = new Error(mode + ' direct');
                        const decorated = new Error(mode + ' decorated');
                        const joined = new Error(mode + ' joined');
                        expected.push(direct, decorated, joined);
                        void core.transactional(() => { throw direct; })();
                        await pause(20);
                        const descriptor = { value() { throw decorated; }, configurable: true, writable: true };
                        core.Transactional()({}, 'fail', descriptor);
                        void descriptor.value();
                        await pause(20);
                        await core.transactional(() => {
                            void core.transactional(async () => { await pause(5); throw joined; })();
                        })();
                        await pause(20);
                        assert.deepEqual(unhandled.splice(0), expected);
                    };
                    if (mode === 'production') await body();
                    else if (mode === 'mock') await testing.mockTransactions(body);
                    else await testing.withTestTransaction(body);
                    await pause(10);
                    assert.deepEqual(unhandled, []);
                }
            })().catch(error => { console.error(error); process.exitCode = 1; });
        `);
    });

    it("rolls back and releases without waiting for forgotten never-settling work", () => {
        runNode(managerScript + `
            const timeout = setTimeout(() => {
                console.error('withTestTransaction waited for forgotten work');
                process.exit(1);
            }, 1000);
            (async () => {
                let entered;
                const started = new Promise(resolve => { entered = resolve; });
                const result = await testing.withTestTransaction(async () => {
                    void core.transactional(() => {
                        entered();
                        return new Promise(() => {});
                    })();
                    await started;
                    return 42;
                });
                assert.equal(result, 42);
                assert.equal(rollbacks, 1);
                assert.equal(releases, 1);
            })().catch(error => { console.error(error); process.exitCode = 1; })
                .finally(() => { clearTimeout(timeout); });
        `);
    });

    it("supports requiring the testing package", () => {
        runNode(`
            const assert = require('node:assert/strict');
            const testing = require('@tranjs/testing');
            for (const name of ['mockTransactions', 'withTestTransaction', 'withTestConnection', 'currentProbe',
                'assertSameTransaction', 'assertSeparateTransaction', 'assertOutsideTransaction',
                'assertAfterCommitOf', 'assertCommitted', 'assertRolledBack']) {
                assert.equal(typeof testing[name], 'function', name);
            }
            assert.equal(typeof testing.matchers.toHaveCommitted, 'function');
            testing.mockTransactions(tx => {
                assert.equal(testing.currentProbe(), tx);
                assert.equal(typeof tx.track, 'function');
                assert.equal(typeof tx.txOf, 'function');
                assert.equal(typeof tx.failNext, 'function');
                assert.deepEqual(tx.records, []);
                assert.equal(Object.isFrozen(tx.records), true);
            }).catch(error => { console.error(error); process.exitCode = 1; });
        `);
    });

    it("supports dynamically importing the testing package", () => {
        runNode(`
            const assert = require('node:assert/strict');
            (async () => {
                const testing = await import('@tranjs/testing');
                for (const name of ['mockTransactions', 'withTestTransaction', 'withTestConnection', 'currentProbe']) {
                    assert.equal(typeof testing[name], 'function', name);
                }
                await testing.mockTransactions(tx => {
                    assert.equal(testing.currentProbe(), tx);
                    assert.equal(typeof tx.track, 'function');
                    assert.equal(typeof tx.txOf, 'function');
                    assert.equal(typeof tx.failNext, 'function');
                    assert.deepEqual(tx.records, []);
                });
            })().catch(error => { console.error(error); process.exitCode = 1; });
        `);
    });

    it("does not load testing modules through the main entry", () => {
        runNode(`
            const assert = require('node:assert/strict');
            const path = require('node:path');
            const testingDirectory = path.dirname(require.resolve('@tranjs/testing')) + path.sep;
            assert.equal(Object.keys(require.cache).some(file => file.startsWith(testingDirectory)), false);
            const core = require('@tranjs/core');
            assert.equal('mockTransactions' in core, false);
            assert.equal('withTestTransaction' in core, false);
            assert.equal(Object.keys(require.cache).some(file => file.startsWith(testingDirectory)), false);
            require('@tranjs/testing');
            assert.equal(Object.keys(require.cache).some(file => file.startsWith(testingDirectory)), true);
        `);
    });

    it("loads the portable entry without loading either runner and preserves the legacy deep import", () => {
        runNode(`
            const assert = require('node:assert/strict');
            const Module = require('node:module');
            const load = Module._load;
            Module._load = function(name, ...args) {
                if (/^(?:vitest|jest|@jest\\/|jest-environment|expect$)/.test(name)) {
                    throw new Error('Portable entry attempted a runner import: ' + name);
                }
                return load.call(this, name, ...args);
            };
            const testing = require('@tranjs/testing');
            assert.equal(typeof testing.withTestTransaction, 'function');
            assert.equal(typeof require('@tranjs/core/dist/asyncLocal').AsyncLocal, 'function');
        `);
    });

    it("allocates testing async-local storage only when a test session starts", () => {
        runNode(`
            const assert = require('node:assert/strict');
            const hooks = require('node:async_hooks');
            const originalDescriptor = Object.getOwnPropertyDescriptor(hooks, 'AsyncLocalStorage');
            const OriginalStorage = hooks.AsyncLocalStorage;
            let allocations = 0;
            Object.defineProperty(hooks, 'AsyncLocalStorage', { configurable: true, value: class extends OriginalStorage {
                constructor(...args) { super(...args); allocations++; }
            }});
            (async () => {
                const core = require('@tranjs/core');
                // The production transaction context has its own storage. Importing
                // the private testing bridge must not allocate a second instance.
                assert.equal(allocations, 1);
                class Manager extends core.PlatformTransactionManager {
                    async beginTransaction() {
                        return { transaction: {}, metadata: { driverName: 'export-test' } };
                    }
                    async commitTransaction() {}
                    async rollbackTransaction() {}
                }
                core.useTransactionManager(new Manager());
                await core.transactional(() => 42)();
                assert.equal(allocations, 1);
                const testing = require('@tranjs/testing');
                assert.equal(allocations, 1);
                await testing.mockTransactions(async () => {
                    await core.transactional(() => 42)();
                });
                assert.equal(allocations, 2);
                await testing.mockTransactions(() => {});
                assert.equal(allocations, 2);
            })().catch(error => { console.error(error); process.exitCode = 1; })
                .finally(() => { Object.defineProperty(hooks, 'AsyncLocalStorage', originalDescriptor); });
        `);
    });

    it("loads the Jest entry through the imported runner expect, not a global", () => {
        runNode(`
            const assert = require('node:assert/strict');
            const Module = require('node:module');
            const load = Module._load;
            let registered;
            let calls = 0;
            Module._load = function(name, ...args) {
                if (name === '@jest/globals') return { expect: { extend(matchers) {
                    registered = matchers;
                    calls++;
                } } };
                return load.call(this, name, ...args);
            };
            assert.equal(globalThis.expect, undefined);
            const entry = require('@tranjs/testing/jest');
            assert.deepEqual(Object.keys(entry), ['matchers']);
            assert.equal(registered, require('@tranjs/testing').matchers);
            assert.equal(entry.matchers, registered);
            assert.equal(Object.keys(registered).length, 6);
            assert.equal(calls, 1);
        `);
    });
});
