const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '../..');
const temporary = mkdtempSync(join(tmpdir(), 'tranjs-differential-'));
const version = process.argv[2] ?? '1.1.0';
const integrities = {
    '1.1.0': 'sha512-b7zLSA0QFgcud7hlUDTxvw9PL2uyNQ+9opSFlSNa2vTrPjw3YhNihX01hzLkH2YEQDdTbMZPOeW7UKmmi7URuQ==',
    '1.2.0': 'sha512-8dW+Y4cZGGJwFmdrsFZzSk41YFJ9/JKVdSmIWf9zccFelKOnKrJX8ABGjhMjAWSSYEokqhDsLT4JIOISrrZHKg==',
};
assert.ok(Object.prototype.hasOwnProperty.call(integrities, version), 'Unsupported published baseline');
const baseline = `@tranjs/core@${version}`;
const archive = join(__dirname, `fixtures/tranjs-core-${version}.tgz`);
const integrity = integrities[version];
const command = (file, args, cwd = root) => execFileSync(file, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
try {
    // Use the original published tarball so the baseline needs no network access.
    const actualIntegrity = 'sha512-' + createHash('sha512').update(readFileSync(archive)).digest('base64');
    assert.equal(actualIntegrity, integrity, 'Published baseline tarball checksum changed');
    command('tar', ['-xzf', archive, '-C', temporary]);
    const metadata = JSON.parse(readFileSync(join(temporary, 'package/package.json'), 'utf8'));
    assert.equal(metadata.name, '@tranjs/core');
    assert.equal(metadata.version, version);
    // Like the package-exports tests, the current package must already be built.
    // Do not rebuild shared dist files while another Jest suite may be loading them.
    const runner = join(__dirname, 'core-no-session-scenarios.cjs');
    const run = entry => JSON.parse(command(process.execPath, [runner, entry]));
    const expected = run(join(temporary, 'package/dist/index.js'));
    const actual = run(join(root, 'packages/core/dist/index.js'));
    assert.equal(expected.length, 96, 'Keep all production probes, including the retained-NESTED guard regression');
    for (const name of ['ctx/implicit-named-datasource', 'hooks/implicit-named-datasource', 'detached/new-transaction-after-commit',
        'hooks/late-after-commit', 'hooks/late-after-rollback', 'hooks/nested-savepoint-rollback', 'hooks/unregistered-datasource', 'nested/retained-ended-sibling', 'non-error-commit/undefined', 'non-error-commit/null', 'non-error-commit/plain failure',
        'combined-release-failure/application', 'combined-release-failure/commit', 'combined-release-failure/rollback',
        'async-hooks/commit', 'async-hooks/application', 'async-hooks/commit-error', 'async-hooks/rollback-error',
        'async-logger/hook-failure', 'async-logger/rollback-failure',
        'timeout/expired-during-begin/query-check', 'timeout/expired-during-begin/completion-check']) {
        assert.ok(expected.some(result => result.name === name), `Missing production probe: ${name}`);
    }
    assert.deepEqual(actual.map(result => result.name), expected.map(result => result.name));
    const closedConnectionNames = ['closed-connection/retained-after-commit', 'closed-connection/retained-after-rollback'];
    const closedError = { error: { name: 'TransactionClosedError', message: 'Transaction already finished' } };
    const closedConnectionResult = (completion, guarded) => ({
        name: `closed-connection/retained-after-${completion}`,
        result: { returned: {
            transaction: completion === 'commit' ? { returned: 1 } : { error: { name: 'Error', message: 'application failed' } },
            retainedContext: guarded ? closedError : { returned: null },
            cachedConnection: guarded ? closedError : { returned: 2 },
            queryCount: guarded ? 1 : 2,
        } },
        outcomes: [completion === 'commit' ? 'committed' : 'rolled-back'],
        events: [
            ['begin', {}, null],
            ['query', 1, 'active'],
            [completion, 1, 1],
            ['release', 1, false, null],
            ...(guarded ? [] : [['query', 1, completion === 'commit' ? 'committed' : 'rolled-back']]),
        ],
        loggerCalls: [], loggerRejections: [], errorIdentity: [], outside: null,
    });
    const namedHooksResult = fixed => ({
        name: 'hooks/implicit-named-datasource', result: { returned: 'named hooks complete' },
        outcomes: ['committed', 'rolled-back'],
        events: [
            ['begin', {}, null],
            ...(!fixed ? [['implicit-commit', 1]] : []),
            ['commit-body', 1], ['commit', 1, 1],
            ...(fixed ? [['implicit-commit', null]] : []),
            ['explicit-commit', null], ['release', 1, false, null],
            ['begin', {}, null],
            ...(!fixed ? [['wrong-commit', 2]] : []),
            ['rollback-body', 2], ['rollback', 2, 2],
            ...(fixed ? [['implicit-rollback', null]] : []),
            ['explicit-rollback', null], ['release', 2, false, null],
        ],
        loggerCalls: [], loggerRejections: [], errorIdentity: [], outside: null,
    });
    const namedContextResult = fixed => ({
        name: 'ctx/implicit-named-datasource',
        result: { returned: {
            implicit: fixed ? { returned: 1 } : { error: { name: 'Error', message: 'Transaction context not initialized' } },
            explicit: 1,
        } },
        outcomes: ['committed'],
        events: [['begin', {}, null], ['named-body', 1], ['commit', 1, 1], ['release', 1, false, null]],
        loggerCalls: [], loggerRejections: [], errorIdentity: [], outside: null,
    });
    const plain = (name, returned, outcomes, events) => ({
        name, result: { returned }, outcomes, events, loggerCalls: [], loggerRejections: [], errorIdentity: [], outside: null,
    });
    // A hook registered after its transaction rolled back follows that outcome.
    const lateAfterRollbackResult = fixed => plain('hooks/late-after-rollback',
        { afterRollbackReturned: fixed ? 'promise' : 'undefined' }, ['rolled-back'], [
            ['begin', {}, null], ['body', 1], ['rollback', 1, 1], ['release', 1, false, null],
            [fixed ? 'late-rollback' : 'late-commit', null], ['after-registration', null],
        ]);
    // Hooks of a NESTED scope follow its savepoint, not only the physical transaction.
    const nestedSavepointResult = fixed => plain('hooks/nested-savepoint-rollback', 'outer result', ['committed'], [
        ['begin', {}, null], ['savepoint', 1, 'tranjs_sp_1', 1], ['rollback-savepoint', 1, 'tranjs_sp_1', 1],
        ...(fixed ? [['nested-rollback', 1]] : []),
        ['caught:nested application failed', 1], ['outer-continues', 1], ['commit', 1, 1], ['outer-commit', null],
        ...(fixed ? [] : [['nested-commit', null]]),
        ['release', 1, false, null],
    ]);
    // A misspelt datasource name is a setup error, not "outside a transaction".
    const setupError = { error: { name: 'TransactionDatasourceSetupError', message: 'Datasource is not set up: misspelt' } };
    const unregisteredResult = fixed => plain('hooks/unregistered-datasource',
        { afterCommit: fixed ? setupError : { returned: null }, afterRollback: fixed ? setupError : { returned: null } }, ['committed'], [
            ['begin', {}, null], ...(fixed ? [] : [['unregistered-commit', 1]]), ['body', 1], ['commit', 1, 1], ['release', 1, false, null],
        ]);
    // A retained ended scope must not supply a second lock for the same open parent.
    const retainedNestedResult = fixed => plain('nested/retained-ended-sibling', {
        c: fixed ? { name: 'ConcurrentNestedTransactionError', message: 'A sibling nested transaction is still open in this parent scope' } : 'succeeded',
    }, ['committed'], [
        ['begin', {}, null], ['savepoint', 1, 'tranjs_sp_1', 1], ['release-savepoint', 1, 'tranjs_sp_1', 1],
        ['savepoint', 1, 'tranjs_sp_2', 1], ['B-open', 1],
        ...(fixed ? [] : [['savepoint', 1, 'tranjs_sp_3', 1], ['C-body', 1], ['release-savepoint', 1, 'tranjs_sp_3', 1]]),
        ['rollback-savepoint', 1, 'tranjs_sp_2', 1], ['caught:B failed', 1], ['commit', 1, 1],
        ...(fixed ? [] : [['C-commit', null]]), ['release', 1, false, null],
    ]);
    const hookDifferences = {
        'hooks/late-after-rollback': lateAfterRollbackResult,
        'hooks/nested-savepoint-rollback': nestedSavepointResult,
        'hooks/unregistered-datasource': unregisteredResult,
        'nested/retained-ended-sibling': retainedNestedResult,
    };
    let unchanged = 0;
    for (let index = 0; index < expected.length; index++) {
        const name = expected[index].name;
        if (version === '1.1.0' && closedConnectionNames.includes(name)) {
            const completion = name.endsWith('commit') ? 'commit' : 'rollback';
            assert.deepEqual(expected[index], closedConnectionResult(completion, false), `Published retained-connection behavior changed: ${name}`);
            assert.deepEqual(actual[index], closedConnectionResult(completion, true), `Closed connection must reject without querying: ${name}`);
        } else if (name === 'hooks/implicit-named-datasource') {
            assert.deepEqual(expected[index], namedHooksResult(false), 'Published implicit named-hook behavior changed');
            assert.deepEqual(actual[index], namedHooksResult(true), 'Implicit hooks must wait for their named transaction');
        } else if (hookDifferences[name]) {
            assert.deepEqual(expected[index], hookDifferences[name](false), `Published hook behavior changed: ${name}`);
            assert.deepEqual(actual[index], hookDifferences[name](true), `Intended hook behavior is missing: ${name}`);
        } else if (name === 'ctx/implicit-named-datasource') {
            assert.deepEqual(expected[index], namedContextResult(false), 'Published implicit named ctx behavior changed');
            assert.deepEqual(actual[index], namedContextResult(true), 'Implicit ctx must select the named transaction');
        } else {
            assert.deepEqual(actual[index], expected[index], `No-session production behavior changed: ${name}`);
            unchanged++;
        }
        assert.equal(actual[index].outside, null, `Leaked transaction: ${actual[index].name}`);
    }
    assert.equal(unchanged, version === '1.1.0' ? 88 : 90, 'All other production scenarios must remain exactly identical');
    process.stdout.write(JSON.stringify({ scenarios: actual.length, baseline, identical: unchanged, intended: actual.length - unchanged, passed: true }) + '\n');
} finally {
    rmSync(temporary, { recursive: true, force: true });
}
