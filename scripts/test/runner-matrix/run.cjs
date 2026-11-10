#!/usr/bin/env node
// Deliberately separate from the workspace: runner aliases never change unit-test dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../../..');
const dependencies = path.join(__dirname, 'node_modules');

function link(source, target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.rmSync(target, { force: true, recursive: true });
    fs.symlinkSync(source, target, 'junction');
}
function prepare(directory, runner) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ private: true, type: 'commonjs' }));
    const modules = path.join(directory, 'node_modules');
    fs.mkdirSync(modules);
    for (const source of [path.join(root, 'node_modules'), dependencies]) {
        for (const entry of fs.readdirSync(source)) {
            if (entry.startsWith('.') || entry === '@tranjs') continue;
            // Keep namespace directories real: runner-specific peer links below
            // must replace sandbox symlinks, never mutate dependency directories.
            if (entry.startsWith('@')) {
                for (const name of fs.readdirSync(path.join(source, entry))) {
                    link(path.join(source, entry, name), path.join(modules, entry, name));
                }
                continue;
            }
            link(path.join(source, entry), path.join(modules, entry));
        }
    }
    // Copy (do not symlink) BUILT packages, so their peer imports resolve this runner.
    for (const name of ['core', 'pg']) {
        const source = path.join(root, 'packages', name);
        assert(fs.existsSync(path.join(source, 'dist/index.js')), 'Run npm run build first');
        const target = path.join(modules, '@tranjs', name);
        fs.mkdirSync(target, { recursive: true });
        fs.copyFileSync(path.join(source, 'package.json'), path.join(target, 'package.json'));
        fs.cpSync(path.join(source, 'dist'), path.join(target, 'dist'), { recursive: true });
    }
    for (const file of fs.readdirSync(__dirname)) {
        if (/\.(cjs|mjs|mts|ts)$/.test(file) && file !== 'run.cjs') fs.copyFileSync(path.join(__dirname, file), path.join(directory, file));
    }
    if (runner.startsWith('vitest')) {
        link(path.join(dependencies, runner), path.join(modules, 'vitest'));
    }
    if (runner.startsWith('jest')) {
        link(path.join(dependencies, runner), path.join(modules, 'jest'));
        const runnerRequire = createRequire(path.join(dependencies, runner, 'package.json'));
        const configRequire = createRequire(runnerRequire.resolve('jest-config/package.json'));
        link(path.dirname(configRequire.resolve('jest-environment-node/package.json')), path.join(modules, 'jest-environment-node'));
        for (const peer of ['expect', '@jest/globals']) {
            link(path.dirname(runnerRequire.resolve(`${peer}/package.json`)), path.join(modules, peer));
        }
        if (runner === 'jest30') link(path.join(dependencies, 'typesjest30'), path.join(modules, '@types/jest'));
    }
    fs.writeFileSync(path.join(directory, 'vitest.config.mjs'), `export default { test: {
        include: process.env.MATRIX_CASE.split(',').map(name => name + '.vitest.mjs'),
        pool: 'threads', maxWorkers: 2, minWorkers: 1,
        silent: false, reporters: ['verbose'], testTimeout: 15000, hookTimeout: 15000,
    } };`);
}
function run(directory, executable, args, { failure, env = {} } = {}) {
    const result = spawnSync(process.execPath, [executable, ...args], {
        cwd: directory, encoding: 'utf8', timeout: 120000,
        env: { ...process.env, NO_COLOR: '1', ...env },
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    process.stdout.write(output);
    if (result.error) throw result.error;
    if (failure) {
        assert.equal(result.status, 1, 'intentional failed test must exit 1');
        assert.match(output, failure, 'missing owning-test failure diagnostic');
    } else assert.equal(result.status, 0, `Runner failed (${args.join(' ')})`);
    return output;
}
function types(directory, runner) {
    const vitest = runner.startsWith('vitest');
    const config = {
        compilerOptions: {
            target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
            strict: true, skipLibCheck: false, noEmit: true, esModuleInterop: true,
            types: vitest ? ['node'] : ['node', 'jest'],
        },
        files: [vitest ? 'types.vitest.mts' : 'types.jest.ts'],
    };
    fs.writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify(config));
    run(directory, path.join(dependencies, 'typescript/bin/tsc'), ['-p', 'tsconfig.json']);
}
function findings(output) {
    for (const marker of [
        'LIFETIME_FAKE_TIMER_B:owner=B:backend=B:persisted=0:A-evidence=0',
        'LIFETIME_DETACHED_B:owner=closed-A:rejected=1:B-evidence=0',
        'LIFETIME_MOCK_DETACHED_B:owner=closed-A:rejected=all-propagations:real-BEGIN=0:callback=0:B-evidence=0:outside=real-SELECT',
        'LIFETIME_MOCK_DETACHED_AFTER_ALL:owner=closed-A:rejected=all-propagations:real-BEGIN=0:callback=0:B-evidence=0:outside=real-SELECT',
        'LIFETIME_MOCK_FAKE_TIMER_B:owner=B:backend=B:persisted=0:A-evidence=0',
        'LIFETIME_MOCK_AFTER_ALL:fake-owner=production:backend=physical:persisted=1:detached=closed-A-rejected',
        'LIFETIME_AFTER_ALL:fake-owner=production:backend=physical:persisted=1:detached=closed-A-rejected',
        'LIFETIME_COMPLETION:owner=production:backend=physical:persisted=1:A-evidence=0',
        'LIFETIME_BOUND_COMPLETION:owner=closed-A:rejected=1',
        'BROKEN_RECOVERY:callback-finally=1:native-savepoint-rollback=1:native-final-rollback=1:error-chain=physical>recovery>application:persisted=0',
    ]) assert(output.includes(marker), `Missing checked finding: ${marker}`);
}
function main() {
    assert(fs.existsSync(path.join(dependencies, 'jest29')), 'Run npm ci --prefix scripts/test/runner-matrix first');
    // Not under node_modules: runners intentionally ignore tests beneath it.
    const sandbox = fs.mkdtempSync(path.join(__dirname, '.sandbox-'));
    const typeChecks = [];
    try {
        for (const runner of ['jest29', 'jest30']) {
            console.log(`\n=== ${runner}: built packages, real PostgreSQL ===`);
            const directory = path.join(sandbox, runner);
            prepare(directory, runner);
            const executable = path.join(directory, 'node_modules/jest/bin/jest.js');
            const jest = (files, extra) => run(directory, executable, ['--runInBand', '--silent=false', '--verbose', '--config', JSON.stringify({
                rootDir: directory, testEnvironment: 'node',
                testRegex: `(${files.join('|')})\\.jest\\.cjs$`, transform: {}, testTimeout: 15000,
            })], extra);
            const output = jest(['portable', 'matchers', 'core-regressions', 'nest', 'lifetime']);
            findings(output);
            const registration = jest(['hook-registration'], { failure: /Hooks cannot be defined inside tests/ });
            assert.match(registration, /LIFETIME_JEST_NESTED_AFTER_EACH:registration=rejected:callback=not-installed/);
            typeChecks.push([directory, runner]);
        }
        for (const runner of ['vitest3', 'vitest4', 'vitest5']) {
            console.log(`\n=== ${runner}: built packages, real PostgreSQL ===`);
            const directory = path.join(sandbox, runner);
            prepare(directory, runner);
            const executable = path.join(directory, 'node_modules/vitest/vitest.mjs');
            const vitest = (name, extra = {}) => run(directory, executable, ['run', '--config', 'vitest.config.mjs', ...(extra.cliArgs || [])], {
                ...extra, env: { ...extra.env, MATRIX_CASE: name },
            });
            findings(vitest('portable,matchers,core-regressions,lifetime'));
            typeChecks.push([directory, runner]);
        }
        console.log('\n=== node:test: portable serial/concurrent and six assertions ===');
        const directory = path.join(sandbox, 'node');
        prepare(directory, 'node');
        run(directory, path.join(directory, 'portable.node.cjs'), []);
        const typeErrors = [];
        for (const [directory, runner] of typeChecks) {
            console.log(`\n=== ${runner}: strict global/imported expect declarations ===`);
            try { types(directory, runner); }
            catch (error) { typeErrors.push(new Error(`${runner}: ${error.message}`, { cause: error })); }
        }
        if (typeErrors.length) throw new AggregateError(typeErrors, 'Runner declaration fixtures failed');
        console.log('\nRunner matrix passed (including observed context-loss limitations and Jest nested-hook rejection).');
    } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
}
try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
