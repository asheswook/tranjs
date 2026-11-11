# @tranjs/testing

Helpers for checking transaction behavior, with a real database or without one. The package includes helpers that roll back test data and matchers for Jest and Vitest.

## Install

```bash
# @tranjs/testing is a dev dependency, next to @tranjs/core and a driver.
npm install --save-dev @tranjs/testing
```

It needs `@tranjs/core` 1.2.0 or later. `withTestConnection` also needs `@tranjs/pg` or `@tranjs/mysql2` 1.3.0, or `@tranjs/postgres` 1.2.0.

## Example

Example with Jest and `pg`. It assumes a registered `pg` manager and a table with one text column, here `example_users(name)`. `@tranjs/postgres` and `@tranjs/mysql2` work the same way.

```typescript
// Example (Jest + pg). Assumes a registered pg manager and any table
// with a text column, here example_users(name).
import { expect, test } from "@jest/globals";
import { transactional } from "@tranjs/core";
import { ctx } from "@tranjs/pg";
import { withTestTransaction } from "@tranjs/testing";
import "@tranjs/testing/jest";

const repository = {
    async save(name: string) {
        await ctx().query("INSERT INTO example_users(name) VALUES ($1)", [name]);
    },
};
function createUserService(repo: typeof repository) {
    return { create: transactional(async (name: string) => repo.save(name)) };
}

test("create saves a user in a transaction", () => withTestTransaction(async tx => {
    const trackedRepository = tx.track(repository);
    const service = createUserService(trackedRepository);
    await service.create("Ada");
    expect(trackedRepository.save).toHaveCommitted();
}));
```

The `import "@tranjs/testing/jest"` line registers the matchers for that file. Listing the same entry in Jest's `setupFilesAfterEnv` (or `@tranjs/testing/vitest` in Vitest's `setupFiles`) registers them for every file instead. The `assert*` functions need no registration.

## Documentation

- [Testing guide](https://github.com/asheswook/tranjs/blob/main/docs/testing.md): the [example setup](https://github.com/asheswook/tranjs/blob/main/docs/testing.md#example-setup), more examples and limits
- [Connection lifetime](https://github.com/asheswook/tranjs/blob/main/docs/drivers.md#connection-lifetime): what a connection does after its transaction or test ends
