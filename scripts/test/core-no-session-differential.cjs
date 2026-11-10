const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '../..');
const temporary = mkdtempSync(join(tmpdir(), 'tranjs-differential-'));
const baseline = '@tranjs/core@1.1.0';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const command = (file, args, cwd = root) => execFileSync(file, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
try {
    // Preserve the published release's behavior, independently of branch history.
    const [packed] = JSON.parse(command(npm, ['pack', baseline, '--json', '--ignore-scripts'], temporary));
    assert.equal(packed.name, '@tranjs/core');
    assert.equal(packed.version, '1.1.0');
    command('tar', ['-xzf', join(temporary, packed.filename), '-C', temporary]);
    const metadata = JSON.parse(readFileSync(join(temporary, 'package/package.json'), 'utf8'));
    assert.equal(metadata.name, '@tranjs/core');
    assert.equal(metadata.version, '1.1.0');
    // Like the package-exports tests, the current package must already be built.
    // Do not rebuild shared dist files while another Jest suite may be loading them.
    const runner = join(__dirname, 'core-no-session-scenarios.cjs');
    const run = entry => JSON.parse(command(process.execPath, [runner, entry]));
    const expected = run(join(temporary, 'package/dist/index.js'));
    const actual = run(join(root, 'packages/core/dist/index.js'));
    assert.ok(expected.length >= 85, 'Keep the broad production scenario matrix and extra failure probes');
    for (const name of ['non-error-commit/undefined', 'non-error-commit/null', 'non-error-commit/plain failure',
        'combined-release-failure/application', 'combined-release-failure/commit', 'combined-release-failure/rollback',
        'async-hooks/commit', 'async-hooks/application', 'async-hooks/commit-error', 'async-hooks/rollback-error',
        'async-logger/hook-failure', 'async-logger/rollback-failure',
        'timeout/expired-during-begin/query-check', 'timeout/expired-during-begin/completion-check']) {
        assert.ok(expected.some(result => result.name === name), `Missing production probe: ${name}`);
    }
    assert.deepEqual(actual.map(result => result.name), expected.map(result => result.name));
    for (let index = 0; index < expected.length; index++) {
        assert.deepEqual(actual[index], expected[index], `No-session production behavior changed: ${expected[index].name}`);
        assert.equal(actual[index].outside, null, `Leaked transaction: ${actual[index].name}`);
    }
    process.stdout.write(JSON.stringify({ scenarios: actual.length, baseline, passed: true }) + '\n');
} finally {
    rmSync(temporary, { recursive: true, force: true });
}
