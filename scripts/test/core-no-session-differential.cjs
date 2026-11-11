const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '../..');
const temporary = mkdtempSync(join(tmpdir(), 'tranjs-differential-'));
const baseline = '@tranjs/core@1.1.0';
const archive = join(__dirname, 'fixtures/tranjs-core-1.1.0.tgz');
const integrity = 'sha512-b7zLSA0QFgcud7hlUDTxvw9PL2uyNQ+9opSFlSNa2vTrPjw3YhNihX01hzLkH2YEQDdTbMZPOeW7UKmmi7URuQ==';
const command = (file, args, cwd = root) => execFileSync(file, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
try {
    // Use the original published tarball so the baseline needs no network access.
    const actualIntegrity = 'sha512-' + createHash('sha512').update(readFileSync(archive)).digest('base64');
    assert.equal(actualIntegrity, integrity, 'Published baseline tarball checksum changed');
    command('tar', ['-xzf', archive, '-C', temporary]);
    const metadata = JSON.parse(readFileSync(join(temporary, 'package/package.json'), 'utf8'));
    assert.equal(metadata.name, '@tranjs/core');
    assert.equal(metadata.version, '1.1.0');
    // Like the package-exports tests, the current package must already be built.
    // Do not rebuild shared dist files while another Jest suite may be loading them.
    const runner = join(__dirname, 'core-no-session-scenarios.cjs');
    const run = entry => JSON.parse(command(process.execPath, [runner, entry]));
    const expected = run(join(temporary, 'package/dist/index.js'));
    const actual = run(join(root, 'packages/core/dist/index.js'));
    assert.equal(expected.length, 90, 'Keep all 87 unchanged probes and all three intended differences');
    for (const name of ['hooks/implicit-named-datasource', 'detached/new-transaction-after-commit', 'non-error-commit/undefined', 'non-error-commit/null', 'non-error-commit/plain failure',
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
    let unchanged = 0;
    for (let index = 0; index < expected.length; index++) {
        const name = expected[index].name;
        if (closedConnectionNames.includes(name)) {
            const completion = name.endsWith('commit') ? 'commit' : 'rollback';
            assert.deepEqual(expected[index], closedConnectionResult(completion, false), `Published retained-connection behavior changed: ${name}`);
            assert.deepEqual(actual[index], closedConnectionResult(completion, true), `Closed connection must reject without querying: ${name}`);
        } else if (name === 'hooks/implicit-named-datasource') {
            assert.deepEqual(expected[index], namedHooksResult(false), 'Published implicit named-hook behavior changed');
            assert.deepEqual(actual[index], namedHooksResult(true), 'Implicit hooks must wait for their named transaction');
        } else {
            assert.deepEqual(actual[index], expected[index], `No-session production behavior changed: ${name}`);
            unchanged++;
        }
        assert.equal(actual[index].outside, null, `Leaked transaction: ${actual[index].name}`);
    }
    assert.equal(unchanged, 87, 'All existing production scenarios and detached new transactions must remain exactly identical');
    process.stdout.write(JSON.stringify({ scenarios: actual.length, baseline, passed: true }) + '\n');
} finally {
    rmSync(temporary, { recursive: true, force: true });
}
