# Changelog

## Core 1.3.0, pg 1.4.0, mysql2 1.4.0, postgres 1.3.0

Changes from the published `@tranjs/core` 1.2.0, `@tranjs/pg` 1.3.0,
`@tranjs/mysql2` 1.3.0 and `@tranjs/postgres` 1.2.0 releases.
`@tranjs/testing` 1.2.0 works with core 1.3.0 and is not re-released.

Earlier releases are described on the
[GitHub releases page](https://github.com/asheswook/tranjs/releases).

### Datasource selection and completed transactions

- With the datasource omitted, hooks and driver `ctx()` select the innermost
  transaction in the calling async context, including a named datasource,
  instead of selecting the default datasource.
- A hook registered from the retained context of a finished transaction follows
  that transaction's outcome. After commit, `afterCommit` still invokes
  immediately and `afterRollback` does nothing. After rollback or failed commit
  or rollback, `afterCommit` does nothing and `afterRollback` invokes
  immediately. Rollback callbacks are logged on error and do not throw; their
  invocation is not proof that the database rolled back.
- This applies to every finished transaction: a single transaction with no outer
  one, a `REQUIRES_NEW` transaction on the same datasource as its outer
  transaction, and a transaction on another datasource. Previously a late
  `afterCommit` invoked its callback after a rollback in the first two cases,
  and a late `afterRollback` was ignored.
- A late hook never moves to an outer transaction that is still active.
  Previously a hook with the datasource omitted could register on an active
  outer transaction of the default datasource.
- An explicit datasource name with no registered manager now throws
  `DatasourceSetupError` for either hook instead of acting as outside a
  transaction. This includes a cleared registration and an explicit
  `DEFAULT_DATASOURCE` without a default manager.

### NESTED scopes

- Hooks follow the savepoint. On successful savepoint rollback, the scope's
  `afterCommit` hooks are discarded and its `afterRollback` hooks run before the
  nested call rejects, inside the still-open enclosing transaction. They do not
  run again if the owner later rolls back. Previously both stayed on the owner.
- Late hooks from a rolled-back nested scope follow that rollback even while
  the owner is active: `afterCommit` does nothing and `afterRollback` invokes
  immediately. Released scopes continue to pass hooks to the enclosing scope.
- In concurrent code, nested hooks are appended to the enclosing scope on
  release. Hooks registered directly on the enclosing scope while the nested
  scope is open therefore run before those nested hooks, rather than in global
  registration order. Sequential code keeps its ordering.
- If a detached nested scope is still open when its owner finishes, its held
  hooks now run when the scope ends, using the owner's outcome. Errors from
  both hook kinds are logged instead of commit-hook errors reaching the owner's
  caller.
- Starting a nested scope from the retained context of an ended scope now also
  checks the concurrency guard of the nearest scope that is still open. An open
  sibling there causes `ConcurrentNestedTransactionError`. Previously the
  retained context could bypass the guard, allowing a sibling rollback to undo
  work whose commit hook later ran. Sequential nesting from retained contexts
  and starting independent physical transactions remain supported.

### Testing and TypeScript

- Test sessions use the same logical outcome rules. If a test ends while an
  owner is still open, late `afterCommit` calls no longer invoke their callbacks;
  late `afterRollback` calls invoke immediately.
- `afterRollback` now returns `void | Promise<void>` instead of `void`. Immediate
  invocation returns a promise that resolves after the callback finishes, with
  callback errors logged and swallowed. Queuing or doing nothing returns
  `undefined`.
- TypeScript migration: `return afterRollback(fn)` in a `void` function, or
  `(): void => afterRollback(fn)`, no longer compiles. Use a statement call,
  such as `afterRollback(fn);`, or widen the return type to
  `void | Promise<void>`.
- Exported state types add optional `TxState.outcome` and
  `TransactionScope.hooks`, `parent` and `outcome` fields.
