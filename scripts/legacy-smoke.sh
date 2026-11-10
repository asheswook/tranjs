#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
mkdir -p "$HOME/work/scratch/revision-impl"
TEMP=$(mktemp -d "$HOME/work/scratch/revision-impl/tranjs-legacy.XXXXXX")
trap 'rm -rf "$TEMP"' EXIT

cd "$ROOT"
npm run build --workspace @tranjs/core
npm pack --workspace @tranjs/core --pack-destination "$TEMP" --json > "$TEMP/pack.json"

# Use a real packed consumer, not workspace links or the current driver sources.
node - "$TEMP" <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const temp = process.argv[2];
const [{ filename }] = JSON.parse(fs.readFileSync(path.join(temp, 'pack.json'), 'utf8'));
fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({
  name: 'tranjs-legacy-smoke',
  private: true,
  dependencies: {
    '@tranjs/core': `file:${path.join(temp, filename)}`,
    '@tranjs/pg': '1.0.16',
    '@tranjs/mysql2': '1.0.19',
  },
  overrides: { '@tranjs/core': '$@tranjs/core' },
}, null, 2));
JS

cd "$TEMP"
npm install --ignore-scripts --no-audit --no-fund
npm ls @tranjs/core --all

cat > smoke.cjs <<'JS'
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const core = require('@tranjs/core');
const { AsyncLocal } = require('@tranjs/core/dist/asyncLocal');
const pg = require('@tranjs/pg');
const mysql = require('@tranjs/mysql2');

assert.strictEqual(AsyncLocal, core.AsyncLocal);
for (const [name, version] of [['@tranjs/pg', '1.0.16'], ['@tranjs/mysql2', '1.0.19']]) {
  assert.equal(require(`${name}/package.json`).version, version);
  const driverRequire = createRequire(require.resolve(name));
  // A nested registry copy would have separate managers and AsyncLocalStorage.
  assert.equal(driverRequire.resolve('@tranjs/core'), require.resolve('@tranjs/core'));
  assert.equal(driverRequire.resolve('@tranjs/core/dist/asyncLocal'), require.resolve('@tranjs/core/dist/asyncLocal'));
}
console.log('Packed core, published driver versions, shared core, and legacy deep import: OK');

async function smoke(name, driver, Manager, pool, acquire, isPostgres) {
  const records = [];
  const commitError = new Error(`${name}: simulated lost COMMIT response`);
  let failCommit = false;
  const trackedPool = {
    [acquire]: async () => {
      const connection = await pool[acquire]();
      const record = { commits: 0, rollbacks: 0, releases: 0 };
      records.push(record);
      // Instrument at the connection boundary: the published driver itself owns
      // release, including on COMMIT failure. Do not add a new-driver release hook.
      return new Proxy(connection, {
        get(target, property) {
          const original = Reflect.get(target, property);
          if (property === 'release') return (...args) => {
            record.releases++;
            return original.apply(target, args);
          };
          if ((isPostgres && property === 'query') ||
              (!isPostgres && (property === 'commit' || property === 'rollback'))) {
            return async (...args) => {
              const operation = isPostgres ? String(args[0]).trim().toUpperCase() : property.toUpperCase();
              if (operation === 'COMMIT') record.commits++;
              if (operation === 'ROLLBACK') record.rollbacks++;
              const result = await original.apply(target, args);
              // A successful physical COMMIT with a failed acknowledgement is a
              // realistic ambiguous outcome and keeps the real pool testable.
              if (operation === 'COMMIT' && failCommit) {
                failCommit = false;
                throw commitError;
              }
              return result;
            };
          }
          return typeof original === 'function' ? original.bind(target) : original;
        },
      });
    },
  };
  core.useTransactionManager(new Manager(trackedPool));
  const table = `tranjs_legacy_${process.pid}_${Math.random().toString(16).slice(2)}`;
  const count = async () => {
    const result = await pool.query(`SELECT COUNT(*) AS count FROM ${table}`);
    return Number((isPostgres ? result.rows : result[0])[0].count);
  };
  const insert = async id => {
    const tx = driver.ctx();
    assert.strictEqual(tx, AsyncLocal.Context.transaction);
    await tx.query(`INSERT INTO ${table} (id) VALUES (${id})`);
    return tx;
  };
  const completion = (commits, rollbacks) => {
    assert.deepEqual(records.at(-1), { commits, rollbacks, releases: 1 });
    assert.equal(AsyncLocal.Context, undefined);
    assert.throws(() => driver.ctx());
  };

  try {
    await pool.query(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`);

    assert.equal(await core.transactional(async () => { await insert(1); return 'committed'; })(), 'committed');
    completion(1, 0);
    assert.equal(await count(), 1);
    console.log(`${name}: commit OK`);

    const applicationError = new Error(`${name}: rollback`);
    await assert.rejects(core.transactional(async () => {
      await insert(2);
      throw applicationError;
    })(), error => error === applicationError);
    completion(0, 1);
    assert.equal(await count(), 1);
    console.log(`${name}: rollback OK`);

    const beforeJoin = records.length;
    await core.transactional(async () => {
      const outer = await insert(3);
      await core.transactional(async () => {
        assert.strictEqual(await insert(4), outer);
        assert.equal(records.at(-1).releases, 0);
      }, { propagation: core.Propagation.REQUIRED })();
      assert.strictEqual(driver.ctx(), outer);
      assert.equal(records.at(-1).commits, 0);
    }, { propagation: core.Propagation.REQUIRED })();
    assert.equal(records.length, beforeJoin + 1);
    completion(1, 0);
    assert.equal(await count(), 3);
    console.log(`${name}: REQUIRED joins one physical transaction OK`);

    failCommit = true;
    await assert.rejects(core.transactional(() => insert(5))(), error => error === commitError);
    completion(1, 0);
    assert.equal(await count(), 4);
    // Single-connection pools make leaked checkouts observable here. A second
    // transaction also checks that no failed scope remains in AsyncLocalStorage.
    await core.transactional(() => insert(6))();
    completion(1, 0);
    assert.equal(await count(), 5);
    console.log(`${name}: commit failure releases once; pool remains healthy OK`);
  } finally {
    try { await pool.query(`DROP TABLE IF EXISTS ${table}`); }
    finally { await pool.end(); }
  }
}

async function main() {
  const pgRequire = createRequire(require.resolve('@tranjs/pg'));
  const { Pool } = pgRequire('pg');
  await smoke('pg@1.0.16', pg, pg.PostgreSQLTransactionManager, new Pool({
    connectionString: process.env.PG_URL || 'postgres://postgres:postgres@localhost:5432/postgres',
    max: 1,
    connectionTimeoutMillis: 10000,
  }), 'connect', true);

  const mysqlRequire = createRequire(require.resolve('@tranjs/mysql2'));
  const mysqlPool = mysqlRequire('mysql2/promise').createPool({
    uri: process.env.MYSQL_URL || 'mysql://root:root@localhost:3306/test',
    connectionLimit: 1,
    connectTimeout: 10000,
  });
  await smoke('mysql2@1.0.19', mysql, mysql.MySQLTransactionManager, mysqlPool, 'getConnection', false);
  console.log('Legacy smoke tests passed');
}

// Fail rather than hang indefinitely if a broken manager leaks the only checkout.
const watchdog = setTimeout(() => {
  console.error('Legacy smoke tests timed out (possible leaked connection)');
  process.exit(1);
}, 60000);
main().then(() => clearTimeout(watchdog), error => {
  clearTimeout(watchdog);
  console.error(error);
  process.exitCode = 1;
});
JS

node smoke.cjs
