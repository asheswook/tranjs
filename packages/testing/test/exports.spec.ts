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
    it("supports requiring the testing package", () => {
        runNode(`
            const assert = require('node:assert/strict');
            const testing = require('@tranjs/testing');
            for (const name of ['mockTransactions', 'withTestTransaction', 'transactions',
                'assertSameTransaction', 'assertSeparateTransaction', 'assertOutsideTransaction',
                'assertAfterCommitOf', 'assertCommitted', 'assertRolledBack']) {
                assert.equal(typeof testing[name], 'function', name);
            }
            assert.equal(typeof testing.matchers.toHaveCommitted, 'function');
            testing.mockTransactions(t => {
                assert.equal(typeof t.track, 'function');
                assert.equal(typeof t.txOf, 'function');
                assert.equal(typeof t.fail, 'function');
                assert.deepEqual(t.transactions, []);
            }).catch(error => { console.error(error); process.exitCode = 1; });
        `);
    });

    it("supports dynamically importing the testing package", () => {
        runNode(`
            const assert = require('node:assert/strict');
            (async () => {
                const testing = await import('@tranjs/testing');
                for (const name of ['mockTransactions', 'withTestTransaction']) {
                    assert.equal(typeof testing[name], 'function', name);
                }
                await testing.mockTransactions(t => {
                    assert.equal(typeof t.track, 'function');
                    assert.equal(typeof t.txOf, 'function');
                    assert.equal(typeof t.fail, 'function');
                    assert.deepEqual(t.transactions, []);
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
