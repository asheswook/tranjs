# @tranjs/testing

Portable transaction sessions, restricted fixtures, probes, assertions, and Jest/Vitest matchers for TranJS.

## Install

```bash
npm install --save-dev @tranjs/testing@1.2.0
npm install @tranjs/core@1.2.0
```

`@tranjs/core@1.2.0` is a required exact peer. Jest 29/30 and Vitest 3/4/5 are optional runner peers; the base entry works with node:test, Mocha, or another runner without either. Compatible drivers are `@tranjs/pg@1.3.0`, `@tranjs/mysql2@1.3.0`, and `@tranjs/postgres@1.2.0` (postgres.js v3/v4).

## Real database sessions

Register the real driver manager once and apply schema migrations separately. Await all database work inside the callback.

```typescript
import { expect, test } from "@jest/globals";
import { transactional } from "@tranjs/core";
import { withTestConnection, withTestTransaction } from "@tranjs/testing";
import type { TestConnection } from "@tranjs/pg";
import { ctx } from "@tranjs/pg";
import "@tranjs/testing/jest";

test("writes through a logical owner", async () => {
    await withTestTransaction(async tx => {
        await withTestConnection(async (db: TestConnection) => {
            await db.query("INSERT INTO users(name) VALUES ($1)", ["Ada"]);
        });
        const read = tx.track(async () => {
            return (await ctx().query("SELECT name FROM users WHERE name = $1", ["Ada"])).rows;
        });
        expect(await transactional(read)()).toEqual([{ name: "Ada" }]);
        expect(read).toHaveCommitted();
    });
});
```

`withTestTransaction(fn, { datasource? }?)` rolls back awaited work routed through the selected manager. Owners use savepoints: "committed" means logical completion, not physical durability. The hidden transaction is not ambient; application SQL still needs `transactional` or `@Transactional`. `transactional(fn, config?)` returns a callable preserving dynamic `this` and arguments, always returning a Promise of the awaited result. It snapshots configuration at creation and resolves the manager at invocation.

`withTestConnection(fn, options?)` supplies a restricted connection usable only during its callback, without changing what driver `ctx()` or `getCurrentTransaction()` returns. It requires a live integration session, not mock mode. Use only the matching type-only `import("@tranjs/pg").TestConnection`, `import("@tranjs/mysql2").TestConnection`, or `import("@tranjs/postgres").TestConnection` export from the driver. pg supports `query(text, values?)`; mysql2 supports `query`/`execute` with native tuples; postgres.js supports tagged calls and `unsafe(text, values?)` returning plain Promises of row lists, not lazy query handles. Native connection controls, callback/config-object queries, streams and cursors are unavailable.

```typescript
import { withTestConnection } from "@tranjs/testing";
import type { TestOptions } from "@tranjs/testing";
import type { TestConnection } from "@tranjs/pg";

export const withPgTestConnection = <R>(fn: (db: TestConnection) => R, options?: TestOptions) => withTestConnection(fn, options);
```

`TestOptions` is `{ datasource?: string | symbol }`. Annotations do not validate datasource wiring. Do not pass this connection into application code.

Each fixture call uses one savepoint. A fixture does not create a service transaction or add a transaction to the probe. TranJS timeouts do not apply; database timeouts still do. You cannot start transactions through TranJS inside a fixture callback, on any datasource; all seven propagation modes are rejected before their callbacks run. Do not nest fixtures or call them from transactional callbacks or commit/rollback hooks, including `afterCommit` callbacks that run immediately without a transaction. Run fixtures and transactional work sequentially: overlapping calls are rejected as soon as they start, even before the first await. The connection and its methods stop working when the callback finishes. Queries still pending at that point fail the fixture call, which waits for them to finish before releasing the savepoint. Await every query. When the session ends, it rejects new fixture calls, waits for existing calls, and preserves unfinished-work and cleanup errors.

SQL-error recovery rolls back to and releases the savepoint while preserving the original native error. If recovery fails, the session cannot continue safely: both errors are preserved, and session cleanup fails even if you catch the fixture error. This recovery differs from production. Keep the connection and its methods inside the callback. Returned data is not checked for nested connection references, and not every missing await is detectable. Fixtures do not make the hidden transaction available through driver `ctx()` and are not a SQL sandbox: COMMIT, DDL, sequences and external effects can escape rollback.

## Unit policy and assertions

`mockTransactions(async tx => …, { datasource? }?)` checks propagation, rollback-only policy, deadlines and hooks with no SQL. Real driver `ctx()` rejects in mock mode. `currentProbe()` returns the live session's probe and throws outside it.

- `tx.track(target)` observes call entry; call through the returned wrapper.
- `tx.txOf(fn, index = 0)` selects a recorded call's owner, or `undefined` for an outside call.
- `tx.records` is a read-only snapshot of logical owner records.
- `tx.failNext("begin" | "commit" | "rollback", selector?)` injects owner-operation failures. Select with `containing` or `where`, not both; `times` defaults to one and `error` is optional. Begin failures cannot use `containing`. Timeout injection is not supported; use ordinary transaction `timeout`.

| Matcher | Portable assertion |
|---|---|
| `toRunInSameTransactionAs` | `assertSameTransaction` |
| `toRunInSeparateTransactionFrom` | `assertSeparateTransaction` |
| `toRunOutsideTransaction` | `assertOutsideTransaction` |
| `toRunAfterCommitOf` | `assertAfterCommitOf` |
| `toHaveCommitted` | `assertCommitted` |
| `toHaveRolledBack` | `assertRolledBack` |

Side-effect import `@tranjs/testing/jest` registers all six with `expect` from `@jest/globals` and supports `injectGlobals: false`. The ESM side-effect import `@tranjs/testing/vitest` registers them with Vitest's `expect`. Manual `expect.extend(matchers)` remains available with `matchers` from the base package. Portable assertions need no runner registration.

Operands must be tracked functions from one probe with exactly one recorded call each; misuse throws even under `.not`. Assertions observe entry, logical outcome and hook provenance, not SQL routing, awaited completion, physical durability or external delivery. `assertAfterCommitOf` requires observed hook provenance, not merely a later outside call.

### Registering matchers for all tests

Jest 29/30 accept the package entry directly, with `injectGlobals` true or false. No user setup file is needed:

```javascript
// jest.config.cjs
module.exports = {
    setupFilesAfterEnv: ["@tranjs/testing/jest"],
};
```

In `tsconfig.json`, load TypeScript augmentation through `types`; keep your project's other entries:

```json
{
    "compilerOptions": {
        "types": ["node", "jest", "@tranjs/testing/jest"],
        "skipLibCheck": false
    }
}
```

For Vitest 3, resolve the entry in config. The same form works with Vitest 4/5 and requires Node 18.19+ or 20.6+:

```javascript
// vitest.config.mjs
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        setupFiles: [fileURLToPath(import.meta.resolve("@tranjs/testing/vitest"))],
    },
});
```

Vitest 4/5 also accept `setupFiles: ["@tranjs/testing/vitest"]`. Add its types separately in `tsconfig.json`:

```json
{
    "compilerOptions": {
        "types": ["node", "@tranjs/testing/vitest"],
        "skipLibCheck": false
    }
}
```

Individual tests need no matcher-entry import. Import `expect`/`test` from the runner as usual when runner globals are disabled. Alternatively, keep registration per file with `import "@tranjs/testing/jest"` or `import "@tranjs/testing/vitest"`; that import supplies both registration and augmentation.

## Limits and real commits

Raw connections, other datasources, detached work, runner hooks and external effects can escape rollback. Closed-session checks protect only work retaining its original context. Unbound timers or runner callbacks can join another session or open production transactions. Await and drain work before returning. Mock external effects: after-commit hooks run after logical completion, before physical rollback.

Within a session, `REQUIRES_NEW` uses the same physical connection; service isolation/read-only requests are recorded, not applied to savepoints. PostgreSQL deferred constraints are checked at owner and nested savepoint completion with their prior modes restored, but not every real COMMIT effect is exercised.

For durability, races, locks, or independent visibility, use no test session: migrate separately, seed/work through `transactional`, verify in a fresh independent transaction, and clean up in `finally` or use a disposable database. Concurrency tests require independent physical transactions outside sessions.

The core main entry loads no `@tranjs/testing`, probe, fake manager, matcher or runner code. No testing AsyncLocalStorage is allocated until a session starts; the internal bridge is inert without a session.

[Testing guide](https://github.com/asheswook/tranjs/blob/main/docs/testing.md): annotated examples for every driver and JavaScript, atomicity checks, tracking, failure selectors, cleanup and lifetime policies.
