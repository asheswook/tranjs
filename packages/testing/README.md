# @tranjs/testing

Check transaction behavior with a real database or without one. The package includes helpers to roll back test data and matchers for Jest and Vitest.

## Install

```bash
npm install --save-dev @tranjs/testing
npm install @tranjs/core @tranjs/pg pg
```

Register a real database manager once in [test setup](https://github.com/asheswook/tranjs/blob/main/docs/testing.md#setup) and create the tables before running this example.

```typescript
import { expect, test } from "@jest/globals";
import { transactional } from "@tranjs/core";
import { ctx } from "@tranjs/pg";
import { withTestTransaction } from "@tranjs/testing";
import "@tranjs/testing/jest";

const repository = {
    async save(name: string) {
        await ctx().query("INSERT INTO docs_users(name) VALUES ($1)", [name]);
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

Register matchers for the suite with `setupFilesAfterEnv: ["@tranjs/testing/jest"]` in Jest or `setupFiles: ["@tranjs/testing/vitest"]` in Vitest.

Queries through a finished test scope throw `TransactionClosedError`, including through cached connections and methods. The helper does not detect missing `await`s; use `@typescript-eslint/no-floating-promises`.

See the [testing guide](https://github.com/asheswook/tranjs/blob/main/docs/testing.md) for setup, examples, and limits.
