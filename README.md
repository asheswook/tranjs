# TranJS

[![Test](https://github.com/asheswook/tranjs/actions/workflows/test.yml/badge.svg)](https://github.com/asheswook/tranjs/actions/workflows/test.yml)

TranJS is a transaction management framework which provides declaretive transaction, without any ORMs. 

It is designed to provide reliable and intuitive transaction management for mission-critical safety applications and general-purpose applications.

## Features
- ✅ **Declarative Transaction via Decorator** (`@Transactional`) or function (`runInTransaction`)
- 🔁 **All 7 Spring Propagations** including `NESTED` (savepoint)
- 🎛️ **Isolation level, read-only, timeout**
- 🗄️ **Multiple datasources**
- 🪝 **`afterCommit` / `afterRollback` hooks**
- ⚡ **TypeScript Native**
- 🛠️ **No Dependencies, Lightweight (15KB)**
- 🚀 **Easy to Use, No Boilerplate Code**
  
## Getting Started
* API Documentation is available at [here](/docs/api.md).
* Native supported drivers are available at [here](/docs/drivers.md).
* The [example](/examples) contains a simple example of how to use the TranJS framework.

## Usage

```typescript
class MyService {
    @Transactional()
    async transfer(from: string, to: string, amount: number) {
        await this.withdrawMoney("Jaewook", 100);
        await this.depositMoney("Chansu", 100);
    }

    @Transactional(Propagation.MANDATORY)
    private async depositMoney(userId: string, amount: number) {
        console.log("Execute Query", userId, amount);
        await ctx().execute("UPDATE user SET balance = balance + ? WHERE id = ?", [amount, userId]);
    }

    @Transactional(Propagation.MANDATORY)
    private async withdrawMoney(userId: string, amount: number) {
        console.log("Execute Query", userId, amount);
        await ctx().execute("UPDATE user SET balance = balance - ? WHERE id = ?", [amount, userId]);
    }
}
```

```bash
Start Transaction (id: ae8wml5i78rt) # Transaction started at transfer()
Execute Query Jaewook 100
Execute Query Chansu 100
Commit Transaction (id: ae8wml5i78rt) # Transaction committed when transfer() finished
```

## Installation

It should be set up for the database you want to use. See [here](/docs/drivers.md).

> [!NOTE]
> If the driver you want to use does not exist, [you can implement it on your own.](/docs/self-implement-guide.md)

## Behaviour changes in 1.1.0

These intentional breaking behaviour changes align with Spring `@Transactional`:

- **Joined failures mark rollback-only.** An error escaping joined `REQUIRED`, `MANDATORY`, or `SUPPORTS` makes the owner roll back with `UnexpectedRollbackError`, even if it catches that error. Migrate catch-and-continue flows to `REQUIRES_NEW` for independent transactions or `NESTED` for savepoints. Locally caught errors are unaffected.
- **Successful savepoint rollback clears rollback-only.** `NESTED` rollback to a savepoint resets the entire `rollbackOnly` flag, even if it was already set before entering the nested scope. If the nested callback returns while rollback-only, core rolls back to the savepoint, clears the flag, and throws `UnexpectedRollbackError`; the outer callback can catch it and commit. An expired deadline is still rechecked by the owner before commit.
- **Rollback failure exposes both errors.** `TransactionSystemError.cause` is the rollback error and `.applicationError` is the original application/timeout/rollback-only error, which is also logged. Update error handlers that previously expected the original error after failed rollback.
- **No rollback after failed commit.** Core runs rollback hooks, rethrows the commit error, and calls the optional `releaseTransaction(tx, failed)` exactly once. Native drivers dispose on failed commit/rollback. Custom drivers may move connection cleanup into the new hook, or keep cleanup inside `commitTransaction`/`rollbackTransaction` with the default no-op hook (never both). If your `commitTransaction` relied on core calling rollback after a failed commit, roll back inside `commitTransaction` instead. A failed commit can have an uncertain outcome; retry cautiously.
- **Timeouts are deadlines.** `timeout` must be finite, nonnegative, and at most `2147483647` ms. Native `ctx()` query/execute calls check the remaining transaction budget and pass it as a per-query client timeout, always overriding user PostgreSQL `query_timeout` / MySQL `timeout` and pool defaults, even shorter ones. Without a transaction deadline, user options are untouched. PostgreSQL now uses `query_timeout`, not begin-time `SET LOCAL statement_timeout`. Use the driver `ctx()` wrapper rather than a raw connection. This does not cancel arbitrary JavaScript or guarantee server-side statement cancellation; rollback can finish after the deadline.
- **PostgreSQL Submittables pass through untouched.** `pg.Query`, `pg-query-stream`, and `pg-cursor` get only a deadline check before dispatch, without per-query timeout injection or interception. The owner still checks before commit; consume streams inside the transactional callback.
- **Commit-hook errors propagate after commit.** `afterCommit` hooks run sequentially and stop at the first error, which is propagated. The transaction remains committed: no rollback or `afterRollback` hooks run, and release happens once with `failed=false`. `afterRollback` errors remain logged and swallowed.

See [API error handling and timeout details](/docs/api.md) and the [custom driver migration guide](/docs/self-implement-guide.md).

## Contribute

TranJS welcomes contributions from the community to enhance its functionality and usability. Here’s how you can contribute:

1. **Report Issues**  
   If you encounter bugs or have suggestions for improvements, feel free to open an issue in the repository.

2. **Submit Pull Requests**  
   Fork the repository, create a new branch for your changes, and submit a pull request. Ensure your code adheres to the project's coding standards and includes relevant tests.

3. **Implement Drivers**  
   If the driver you need is not available, you can implement it yourself using the [self-implement guide](/docs/self-implement-guide.md).

4. **Improve Documentation**  
   Contributions to the documentation are always appreciated—whether it's fixing typos, adding examples, or clarifying complex concepts.

5. **Collaborate and Review**  
   Participate in discussions, review pull requests, and provide constructive feedback to other contributors.

## License

This project is licensed under the LGPL-2.1 License - see the [LICENSE](LICENSE) file for details.

## Acknowledgement

* [Spring Framework](https://github.com/spring-projects/spring-framework)
* [Hibernate](https://github.com/hibernate/hibernate-orm)
