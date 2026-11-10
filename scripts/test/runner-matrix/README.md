# Built-package runner matrix

Requires Node 20.19+ (or 22.12+), PostgreSQL, and built workspace packages:

```sh
npm install
npm run build
npm ci --prefix scripts/test/runner-matrix
PG_URL=postgres://postgres:postgres@localhost:5432/postgres npm run test:runners
```

The separate dependency tree pins Jest 29/30 and Vitest 3/4/5 using aliases.
Each runner receives **copies of dist + package.json**, never source imports,
and matching peers. Sandbox namespace directories stay physical, so peer links
cannot overwrite installed dependency namespaces. Jest's own dependency supplies
its matching node environment; there is no tranjs environment or lifecycle adapter.

Coverage includes portable serial/concurrent `withTestTransaction` scopes, Nest DI
(Jest), six matchers with negation/misuse, and strict global/imported expect types
with `skipLibCheck: false` and matching Jest type majors. node:test checks portable
serial/concurrent scopes and all six portable assertion functions. Core regressions
retain initialization guards, diagnostic labels, and public commit/recovery failure
injection. A custom pg-manager subclass performs real savepoint/final rollback SQL
before throwing: both callback finally blocks run, the `TransactionSystemError`
chain preserves physical/recovery/application errors, and no rows persist.

Config-only registration uses `setupFilesAfterEnv: ["@tranjs/testing/jest"]` on
Jest 29/30 with globals on/off. Vitest 3 uses a file path from
`fileURLToPath(import.meta.resolve("@tranjs/testing/vitest"))`; Vitest 4/5 run both
that form and `setupFiles: ["@tranjs/testing/vitest"]`. The config-only test files
have no matcher-entry import or manual extension and cover all six matchers,
`.not`, and `.resolves`. Separate strict type fixtures load augmentation only
through `compilerOptions.types`, without an entry import in each test file.

## Actual lifetime boundaries (not automatic isolation)

`withTestTransaction` and `mockTransactions` scope **awaited work in their callback**,
not a runner's entire test lifecycle. They cannot intercept runner callback registration or fake-timer
dispatch. The matrix deliberately measures those boundaries rather than claiming
that all work scheduled in A belongs to A:

| Work scheduled in A | Dispatch | Observed owner / persistence |
| --- | --- | --- |
| Native detached Promise | Resolved inside B or afterAll | Retains closed A; transactional body rejects; no B evidence or SQL |
| Unbound fake timer | Flushed inside B | Inherits B, including B's backend PID and probe evidence; B rolls back the write; A has no evidence |
| Unbound fake timer | Flushed in afterAll | No test session; physical production transaction **commits**, externally visible |
| Vitest `onTestFinished` registered inside helper | Runner completion | No test session; physical production transaction **commits**, externally visible |
| Jest `afterEach` registered inside helper | Registration | Jest rejects registration inside tests; callback is not installed |
| Jest pre-registered `afterEach` using callback assigned inside helper | Runner completion | No test session; physical production transaction **commits**, externally visible |
| User-bound completion callback | Runner completion | `AsyncLocalStorage.bind` retains closed A; transactional body rejects |

These outcomes are checked separately on Jest 29/30 and Vitest 3/4/5. The nested
Jest registration suite intentionally exits 1, and passes the matrix only with
Jest's diagnostic plus a teardown sentinel proving the callback was not installed.
Other cases emit `LIFETIME_*` / `BROKEN_RECOVERY` stdout sentinels only after their
identity, evidence, rollback/visibility, and error-chain assertions pass. Escaped
rows are explicitly deleted in finally blocks before the normal zero-leak check.

Native detached Promises and both fake-timer dispatch branches also start inside
`mockTransactions` A. The native cases restore a counting real pg manager before
dispatch in B/afterAll: all propagation modes reject closed A, with **zero late
real BEGINs/callbacks and no B evidence**. An outside caller then starts its own
real transaction and executes SELECT successfully, proving the guard does not
poison unrelated live contexts. Fake timers still adopt B/production after losing
mock A's provenance; their intentionally escaped rows receive the same cleanup.

Do not leave fake timers or detached runner hooks unawaited and assume they retain
the helper's scope. Flush/await them **inside the originating callback**. If a
callback must outlive it, users can explicitly capture native ALS context:

```js
await withTestTransaction(async () => {
  onTestFinished(AsyncLocalStorage.bind(async () => {
    // Retains this now-closed scope: transactional work rejects, never rebinds.
  }));
});
```

The fixtures exercise this explicit user-owned binding; tranjs adds no callback
API, global patches, prototype wrappers, or runner-internal integration. Without
such binding, lost provenance cannot be reconstructed by a portable helper.
Temporary sandboxes are removed even when checks fail.
