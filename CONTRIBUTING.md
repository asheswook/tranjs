# Contributing

Issues and pull requests are welcome at <https://github.com/asheswook/tranjs>.

## Local setup

The driver and testing suites use real databases. `docker-compose.yml` at the repository root starts PostgreSQL 16 and MySQL 8 with the credentials the tests default to.

```bash
# From the repository root. Starts the databases, installs and runs the main suites.
docker compose up -d
npm install
npm run build && npm test
```

`PG_URL` and `MYSQL_URL` override the test connection strings. The defaults are `postgres://postgres:postgres@localhost:5432/postgres` and `mysql://root:root@localhost:3306/test`.

## Test commands

| Command | What it runs |
|---|---|
| `npm test` | The Jest suites of every package, then the combined core coverage check |
| `npm run test:postgres:v3` | The `@tranjs/postgres` suite against postgres.js 3.4.x in an isolated workspace; the installed 4.x dependency is unchanged |
| `npm run test:types` | Consumer type fixtures under `test/types` |
| `npm run test:types:postgres:v3` | The same type fixtures against postgres.js 3.x types |
| `npm run test:runners` | The built packages on Jest 29 and 30, Vitest 3 to 5 and node:test. Needs `npm ci --prefix scripts/test/runner-matrix` first; see `scripts/test/runner-matrix/README.md` |
| `npm run test:packed` | Packed tarballs installed into a consumer project |
| `npm run test:legacy` | A smoke test of the published legacy drivers |
| `bash scripts/test/postgres-node-compat.sh --all` | The built CommonJS `@tranjs/postgres` with both postgres.js majors on Node.js 18, 20.10 and 22 (with `--no-experimental-require-module` on 22) |

They run against the built packages, so `npm run build` comes first. Tests for dirty-reservation release, disconnect behavior, batch queries and instance `query_timeout` run only on postgres.js 4.x.

`scripts/test/postgres-node-compat.sh` with no arguments uses the current `node`. A runner argument selects one version, for example `bash scripts/test/postgres-node-compat.sh npx -y node@20.10.0`.

## Documentation

`README.md` and `packages/core/README.md` are the same file twice, and CI compares them with `cmp README.md packages/core/README.md`. A change to one goes into both.

The [custom driver guide](docs/self-implement-guide.md) describes the manager contract for a new driver.
