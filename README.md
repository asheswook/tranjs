# tranjs

Node.js transaction management framework inspired by Spring's `@Transactional` annotation.

## Usage

You can use like this:

```typescript
class MyService {
    @Transactional()
    async doSomething() {
        await this.doSomethingElse("1", "Alice");
        await this.doSomethingElse("2", "Bob");
    }

    @Transactional()
    @Query("INSERT INTO user (id, name) VALUES (:id, :name)")
    async doSomethingElse(
        @Param('id') id: string,
        @Param('name') name: string,
    ) {
        console.log("Execute Query", id, name);
    }
}
```
```
beginTransaction (id: 0e8wml5i78rt)
Execute Query 1 Alice
Execute Query 2 Bob
commitTransaction (id: 0e8wml5i78rt)
```

## Propagation

Propagation refers to the behavior of how transactions are managed when a transactional method is called within another transactional method. The node-transaction framework provides the following propagation options, inspired by Spring:

### Propagation Types

1. REQUIRED (default)
- If a transaction already exists, it will be reused.
- If no transaction exists, a new transaction will be started.

Example:

```typescript
@Transactional(Propagation.REQUIRED)
async doSomething() {
    // Reuses the existing transaction or starts a new one.
}
```

2. REQUIRES_NEW
- Always starts a new transaction, suspending any existing transaction.

```typescript
@Transactional(Propagation.REQUIRES_NEW)
async doSomething() {
    // Always starts a new transaction.
}
```

The following propagation types are not supported yet:
- NESTED
- MANDATORY
- SUPPORTS
- NOT_SUPPORTED
- NEVER