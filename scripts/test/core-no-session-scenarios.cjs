// Executed in a fresh Node process for each built core: never imports /testing.
const core = require(process.argv[2]);
const { AsyncResource } = require('node:async_hooks');
const { existsSync } = require('node:fs');
const { dirname, join } = require('node:path');
const contextEntry = join(dirname(process.argv[2]), 'internal/context.js');
// Model the driver lookup with the internal helper, or the published driver's default lookup.
const resolveContextManager = existsSync(contextEntry) ? require(contextEntry).resolveContextManager : core.getTransactionManager;

function driverContext(datasource) {
    const manager = resolveContextManager(datasource);
    manager.assertCurrentTransactionOpen?.();
    const transaction = manager.getCurrentTransaction();
    if (!transaction) throw new Error('Transaction context not initialized');
    return transaction;
}

function errorInfo(error) {
    if (!(error instanceof Error)) return { thrown: error === undefined ? '<undefined>' : error };
    return {
        name: error.name, message: error.message,
        ...('cause' in error ? { cause: errorInfo(error.cause) } : {}),
        ...('applicationError' in error ? { applicationError: errorInfo(error.applicationError) } : {}),
    };
}

async function scenario(name, callback, faults = {}) {
    const events = [];
    const outcomes = [];
    const loggerCalls = [];
    const identities = [];
    const loggerRejections = [];
    const loggerPromises = [];
    const observe = (label, value) => {
        identities.push([label, value]);
        if (value instanceof Error) {
            if ('cause' in value) observe(`${label}.cause`, value.cause);
            if ('applicationError' in value) observe(`${label}.applicationError`, value.applicationError);
        }
        return value;
    };
    const failure = (label, ...values) => observe(`source:${label}`, values.length ? values[0] : new Error(`${label} failed`));
    const hasFault = operation => Object.prototype.hasOwnProperty.call(faults, operation);
    const fail = operation => {
        if (hasFault(operation)) throw failure(operation, faults[operation] === true ? new Error(`${operation} failed`) : faults[operation]);
    };
    let now = 1000000;
    const originalNow = Date.now;
    Date.now = () => now;
    class Manager extends core.PlatformTransactionManager {
        constructor() {
            super(Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, (...args) => {
                loggerCalls.push([level, ...args.map(arg => arg instanceof Error ? errorInfo(arg) : arg)]);
                args.forEach((arg, index) => observe(`logger:${loggerCalls.length - 1}:${index}`, arg));
                if (faults.logger) throw new Error('logger failed');
                if (faults.asyncLogger) {
                    const rejected = Promise.reject(failure('async logger'));
                    // Observe the returned rejection ourselves: production intentionally
                    // does not await a logger, and this probe must not crash Node.
                    loggerPromises.push(rejected.catch(error => {
                        observe(`logger-rejection:${loggerRejections.length}`, error);
                        loggerRejections.push(errorInfo(error));
                    }));
                    return rejected;
                }
            }])));
        }
        current() { return this.getCurrentTransaction()?.id ?? null; }
        connection() {
            const tx = this.getCurrentTransaction();
            // Model the public driver wrapper: capture this checkout's gate, not
            // a later lookup of the same raw connection. Published 1.1.0 has no
            // gate API and historically permits queries after release.
            const gate = this.getConnectionGate?.(tx);
            return { query: () => {
                if (gate) this.assertConnectionOpen(gate);
                events.push(['query', tx.id, outcomes[tx.id - 1]]);
                this.queryCount = (this.queryCount ?? 0) + 1;
                return this.queryCount;
            } };
        }
        async beginTransaction(options) {
            events.push(['begin', options ?? {}, this.current()]);
            fail('begin');
            now += faults.beginAdvance ?? 0;
            const transaction = { id: outcomes.length + 1 };
            outcomes.push('active');
            return { transaction, metadata: { driverName: 'differential' } };
        }
        async commitTransaction(tx) {
            events.push(['commit', tx.id, this.current()]);
            outcomes[tx.id - 1] = hasFault('commit') ? 'commit-failed' : 'committed';
            fail('commit');
        }
        async rollbackTransaction(tx) {
            events.push(['rollback', tx.id, this.current()]);
            outcomes[tx.id - 1] = hasFault('rollback') ? 'rollback-failed' : 'rolled-back';
            fail('rollback');
        }
        async releaseTransaction(tx, failed) {
            events.push(['release', tx.id, failed, this.current()]);
            fail('release');
        }
        async createSavepoint(tx, savepoint) {
            events.push(['savepoint', tx.id, savepoint, this.current()]);
            fail('savepoint');
        }
        async rollbackToSavepoint(tx, savepoint) {
            events.push(['rollback-savepoint', tx.id, savepoint, this.current()]);
            if (hasFault('rollbackSavepoint')) throw failure('rollbackSavepoint', new Error('rollback savepoint failed'));
        }
        async releaseSavepoint(tx, savepoint) {
            events.push(['release-savepoint', tx.id, savepoint, this.current()]);
            if (hasFault('releaseSavepoint')) throw failure('releaseSavepoint', new Error('release savepoint failed'));
        }
        remaining() { return this.getRemainingTimeout(); }
        expire() { return this.expireTransaction(); }
    }
    const manager = new Manager();
    core.useTransactionManager(manager);
    const mark = label => events.push([label, manager.current()]);
    const run = (fn, config) => core.transactional ? core.transactional(fn, config)() : core.runInTransaction(fn, config);
    const hook = (label, throws = false) => () => {
        mark(label);
        if (throws) throw failure(label);
    };
    const asyncHook = (label, throws = false) => async () => {
        mark(label);
        await Promise.resolve();
        mark(`${label}:awaited`);
        if (throws) throw failure(label);
    };
    let result;
    try {
        result = { returned: await callback({ run, mark, hook, asyncHook, failure, manager, advance: ms => { now += ms; } }) };
    } catch (error) {
        observe('thrown', error);
        result = { error: errorInfo(error) };
    } finally {
        await Promise.all(loggerPromises);
        Date.now = originalNow;
        // useTransactionManager(undefined) is supported by both revisions.
        core.useTransactionManager(undefined);
    }
    // Preserve exact equality relationships (including cause/applicationError and
    // logger arguments), never process-specific stacks or object addresses.
    const errorIdentity = identities.map(([label, value]) => ({
        label, equalTo: identities.filter(([, other]) => Object.is(value, other)).map(([otherLabel]) => otherLabel),
    }));
    return { name, result, outcomes, events, loggerCalls, loggerRejections, errorIdentity, outside: manager.current() };
}

async function main() {
    const results = [];
    const add = async (name, callback, faults) => results.push(await scenario(name, callback, faults));
    const P = core.Propagation;
    for (const propagation of Object.values(P)) {
        for (const outer of [false, true]) {
            for (const fail of [false, true]) {
                await add(`propagation/${propagation}/${outer ? 'inside' : 'outside'}/${fail ? 'throw' : 'return'}`,
                    async ({ run, mark }) => {
                        const call = () => run(() => {
                            mark('body');
                            if (fail) throw new Error('application failed');
                            return 42;
                        }, { propagation });
                        return outer ? run(async () => {
                            mark('outer-before');
                            try { return await call(); }
                            finally { mark('outer-after'); }
                        }) : call();
                    });
            }
        }
    }
    for (const propagation of [P.REQUIRED, P.SUPPORTS, P.MANDATORY, P.REQUIRES_NEW, P.NESTED]) {
        await add(`caught-inner-failure/${propagation}`, ({ run, mark }) => run(async () => {
            try { await run(() => { throw new Error('inner failed'); }, { propagation }); }
            catch (error) { mark(`caught:${error.name}`); }
            mark('outer-continues');
            return 'outer result';
        }));
    }
    for (const faults of [{ begin: true }, { commit: true }, { rollback: true }, { release: true },
        { rollback: true, logger: true }, { savepoint: true }, { rollbackSavepoint: true },
        { releaseSavepoint: true }, { rollbackSavepoint: true, logger: true }]) {
        await add(`driver-failure/${Object.keys(faults).join('+')}`, ({ run, hook }) => run(async () => {
            core.afterCommit(hook('after-commit'));
            core.afterRollback(hook('after-rollback'));
            if (faults.rollback) throw new Error('application failed');
            if (faults.savepoint || faults.rollbackSavepoint || faults.releaseSavepoint) {
                try {
                    await run(() => {
                        if (faults.rollbackSavepoint) throw new Error('nested application failed');
                        return 'nested result';
                    }, { propagation: P.NESTED });
                } catch (error) { hook(`caught:${error.name}`)(); }
            }
            return 'result';
        }), faults);
    }
    for (const completion of ['commit', 'application-error', 'commit-error', 'rollback-error']) {
        for (const throwingHook of [false, true]) {
            await add(`hooks/${completion}/${throwingHook ? 'throw' : 'success'}`, ({ run, hook }) => run(async () => {
                core.afterCommit(hook('commit-1', throwingHook));
                core.afterCommit(hook('commit-2'));
                core.afterRollback(hook('rollback-1', throwingHook));
                core.afterRollback(hook('rollback-2'));
                await run(() => {
                    core.afterCommit(hook('nested-commit'));
                    core.afterRollback(hook('nested-rollback'));
                }, { propagation: P.NESTED });
                if (completion === 'application-error' || completion === 'rollback-error') throw new Error('application failed');
                return 'result';
            }), { ...(completion === 'commit-error' ? { commit: true } : {}), ...(completion === 'rollback-error' ? { rollback: true } : {}) });
        }
    }
    await add('hooks/outside', async ({ hook }) => {
        await core.afterCommit(hook('immediate-commit'));
        core.afterRollback(hook('ignored-rollback'));
        return 'outside result';
    });
    await add('hooks/requires-new-order', ({ run, hook }) => run(async () => {
        core.afterCommit(hook('outer-commit'));
        await run(() => core.afterCommit(hook('inner-commit')), { propagation: P.REQUIRES_NEW });
        hook('outer-resumed')();
    }));
    await add('nested/reentrant', ({ run, mark }) => run(() => run(() => run(() => {
        mark('deepest');
        return 'nested result';
    }, { propagation: P.NESTED }), { propagation: P.NESTED })));
    for (const thrown of [undefined, null, 'plain failure', 0]) {
        await add(`non-error-throw/${String(thrown)}`, ({ run, failure }) => run(() => { throw failure('application', thrown); }), { rollback: true });
    }
    for (const thrown of [undefined, null, 'plain failure']) {
        await add(`non-error-commit/${String(thrown)}`, ({ run, hook }) => run(() => {
            core.afterRollback(hook('rollback-hook'));
            return 'result';
        }), { commit: thrown });
    }
    for (const completion of ['application', 'commit', 'rollback']) {
        await add(`combined-release-failure/${completion}`, ({ run, hook, failure }) => run(() => {
            core.afterCommit(hook('commit-hook'));
            core.afterRollback(hook('rollback-hook'));
            if (completion !== 'commit') throw failure('application');
            return 'result';
        }), { release: true, ...(completion === 'application' ? {} : { [completion]: true }) });
    }
    for (const completion of ['commit', 'application', 'commit-error', 'rollback-error']) {
        await add(`async-hooks/${completion}`, ({ run, asyncHook, failure }) => run(() => {
            core.afterCommit(asyncHook('commit-1', true));
            core.afterCommit(asyncHook('commit-2'));
            core.afterRollback(asyncHook('rollback-1', true));
            core.afterRollback(asyncHook('rollback-2'));
            if (completion === 'application' || completion === 'rollback-error') throw failure('application');
            return 'result';
        }), { ...(completion === 'commit-error' ? { commit: true } : {}), ...(completion === 'rollback-error' ? { rollback: true } : {}) });
    }
    for (const rollback of [false, true]) {
        await add(`async-logger/${rollback ? 'rollback-failure' : 'hook-failure'}`, ({ run, asyncHook, failure }) => run(() => {
            core.afterRollback(asyncHook('rollback-hook', true));
            throw failure('application');
        }), { asyncLogger: true, ...(rollback ? { rollback: true } : {}) });
    }
    await add('timeout/zero', ({ run, mark }) => run(() => mark('body'), { timeout: 0 }));
    await add('timeout/expired', ({ run, advance, manager }) => run(() => {
        advance(11);
        return manager.remaining();
    }, { timeout: 10 }));
    await add('timeout/query-expiration', ({ run, manager }) => run(() => {
        throw manager.expire();
    }, { timeout: 10 }));
    await add('timeout/not-expired', ({ run, manager }) => run(() => manager.remaining(), { timeout: 10 }));
    for (const queryCheck of [false, true]) {
        await add(`timeout/expired-during-begin/${queryCheck ? 'query-check' : 'completion-check'}`, ({ run, mark, manager }) => run(() => {
            mark('body');
            return queryCheck ? manager.remaining() : 'result';
        }, { timeout: 10 }), { beginAdvance: 11 });
    }
    for (const timeout of [-1, Infinity, NaN, 2147483648]) {
        await add(`timeout/invalid/${String(timeout)}`, ({ run }) => run(() => 42, { timeout }));
    }
    await add('isolation/invalid', ({ run }) => run(() => 42, { isolationLevel: 'INVALID' }));
    for (const isolationLevel of Object.values(core.IsolationLevel)) {
        await add(`isolation/${isolationLevel}`, ({ run }) => run(() => 42, { isolationLevel }));
    }
    await add('propagation/invalid', ({ run }) => run(() => 42, { propagation: 'INVALID' }));
    await add('datasource/missing', ({ run }) => run(() => 42, { datasource: 'missing' }));
    await add('hooks/implicit-named-datasource', async ({ run, mark, hook, manager }) => {
        const datasource = 'analytics';
        core.useTransactionManager(manager, datasource);
        core.useTransactionManager(undefined);
        try {
            await run(() => {
                core.afterCommit(hook('implicit-commit'));
                core.afterCommit(hook('explicit-commit'), datasource);
                core.afterRollback(hook('wrong-rollback'));
                mark('commit-body');
            }, { datasource });
            try {
                await run(() => {
                    core.afterCommit(hook('wrong-commit'));
                    core.afterRollback(hook('implicit-rollback'));
                    core.afterRollback(hook('explicit-rollback'), datasource);
                    mark('rollback-body');
                    throw new Error('named body failed');
                }, { datasource });
            } catch (error) {
                if (error.message !== 'named body failed') throw error;
            }
            return 'named hooks complete';
        } finally { core.useTransactionManager(undefined, datasource); }
    });
    // Work that kept the async context of a finished transaction registers both hooks.
    for (const completion of ['commit', 'rollback']) {
        await add(`hooks/late-after-${completion}`, async ({ run, mark, hook }) => {
            let late;
            try {
                await run(() => {
                    late = AsyncResource.bind(callback => callback());
                    mark('body');
                    if (completion === 'rollback') throw new Error('application failed');
                });
            } catch (error) {
                if (error.message !== 'application failed') throw error;
            }
            const returned = late(() => {
                core.afterCommit(hook('late-commit'));
                return core.afterRollback(hook('late-rollback'));
            });
            await returned;
            mark('after-registration');
            return { afterRollbackReturned: returned instanceof Promise ? 'promise' : String(returned) };
        });
    }
    await add('hooks/nested-savepoint-rollback', ({ run, mark, hook }) => run(async () => {
        core.afterCommit(hook('outer-commit'));
        core.afterRollback(hook('outer-rollback'));
        try {
            await run(() => {
                core.afterCommit(hook('nested-commit'));
                core.afterRollback(hook('nested-rollback'));
                throw new Error('nested application failed');
            }, { propagation: P.NESTED });
        } catch (error) { mark(`caught:${error.message}`); }
        mark('outer-continues');
        return 'outer result';
    }));
    await add('hooks/unregistered-datasource', ({ run, mark, hook }) => run(() => {
        const capture = callback => {
            try { return { returned: callback() ?? null }; }
            catch (error) { return { error: errorInfo(error) }; }
        };
        const result = {
            afterCommit: capture(() => core.afterCommit(hook('unregistered-commit'), 'misspelt')),
            afterRollback: capture(() => core.afterRollback(hook('unregistered-rollback'), 'misspelt')),
        };
        mark('body');
        return result;
    }));
    await add('ctx/implicit-named-datasource', async ({ run, mark, manager }) => {
        const datasource = 'analytics';
        core.useTransactionManager(manager, datasource);
        core.useTransactionManager(new manager.constructor());
        try {
            return await run(() => {
                let implicit;
                try { implicit = { returned: driverContext().id }; }
                catch (error) { implicit = { error: errorInfo(error) }; }
                const explicit = driverContext(datasource).id;
                mark('named-body');
                return { implicit, explicit };
            }, { datasource });
        } finally { core.useTransactionManager(undefined, datasource); }
    });
    await add('detached/new-transaction-after-commit', async ({ run, mark, manager }) => {
        let resume;
        const ready = new Promise(resolve => { resume = resolve; });
        let detached;
        await run(() => {
            mark('parent');
            detached = ready.then(() => run(() => {
                mark('detached');
                return manager.connection().query();
            }));
        });
        resume();
        return detached;
    });
    for (const completion of ['commit', 'rollback']) {
        await add(`closed-connection/retained-after-${completion}`, async ({ run, manager }) => {
            const capture = callback => {
                try { return { returned: callback() }; }
                catch (error) { return { error: errorInfo(error) }; }
            };
            let retainedContext;
            let connection;
            let transaction;
            try {
                transaction = { returned: await run(() => {
                    connection = manager.connection();
                    retainedContext = AsyncResource.bind(() => {
                        manager.assertCurrentTransactionOpen?.();
                        return manager.getCurrentTransaction()?.id ?? null;
                    });
                    const result = connection.query();
                    if (completion === 'rollback') throw new Error('application failed');
                    return result;
                }) };
            } catch (error) { transaction = { error: errorInfo(error) }; }
            return {
                transaction,
                retainedContext: capture(retainedContext),
                cachedConnection: capture(() => connection.query()),
                queryCount: manager.queryCount,
            };
        });
    }
    process.stdout.write(JSON.stringify(results));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
