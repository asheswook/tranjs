const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdtempSync, symlinkSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '../..');
const approvedTemporaryRoot = '/private/var/folders/3z/4k2d2fs94w15kcv6lndg5f9w0000gn/T/opencode';
const temporary = mkdtempSync(join(existsSync(approvedTemporaryRoot) ? approvedTemporaryRoot : tmpdir(), 'tranjs-differential-'));
const baseline = join(temporary, 'main');
const command = (file, args, cwd = root) => execFileSync(file, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
let added = false;
try {
    // Full CI checkouts expose origin/main but need not create a local main branch.
    let baselineRef = 'main';
    try { command('git', ['rev-parse', '--verify', baselineRef]); }
    catch { baselineRef = 'origin/main'; }
    command('git', ['worktree', 'add', '--detach', baseline, baselineRef]);
    added = true;
    // Resolve TypeScript's node/jest types without installing another dependency tree.
    symlinkSync(join(root, 'node_modules'), join(baseline, 'node_modules'), 'dir');
    const tsc = join(root, 'node_modules/typescript/bin/tsc');
    command(process.execPath, [tsc, '-b', 'packages/core', '--force'], baseline);
    // Like the package-exports tests, the current package must already be built.
    // Do not rebuild shared dist files while another Jest suite may be loading them.
    const runner = join(__dirname, 'core-no-session-scenarios.cjs');
    const run = directory => JSON.parse(command(process.execPath, [runner, join(directory, 'packages/core/dist/index.js')]));
    const expected = run(baseline);
    const actual = run(root);
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
    process.stdout.write(JSON.stringify({ scenarios: actual.length, baseline: command('git', ['rev-parse', baselineRef]).trim(), passed: true }) + '\n');
} finally {
    // Only this script's fresh worktree is removed; --force discards its build outputs/symlink.
    if (added) command('git', ['worktree', 'remove', '--force', baseline]);
    rmSync(temporary, { recursive: true, force: true });
}
