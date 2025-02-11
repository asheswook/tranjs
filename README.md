# TranJS

[![Test](https://github.com/asheswook/tranjs/actions/workflows/test.yml/badge.svg)](https://github.com/asheswook/tranjs/actions/workflows/test.yml)

**Node.js Transaction Management Framework**

TranJS is a transaction management framework for Node.js, inspired by Java Hibernate's `@Transactional` annotation.
It is designed to provide reliable and intuitive transaction management for mission-critical safety applications and general-purpose applications.

**This framework is now experimental and under development. Please feel free to contribute or provide feedback.**

## Features
- ✅ **Effortless Declarative Transactions**
- ⚡ **TypeScript Native**
- 🛠️ **No Dependencies, Lightweight (15KB)**
- 🔄 **Flexible Transaction Propagation**

## Getting Started
* API Documentation is available at [here](/docs/api.md).
* The [example](/examples) contains a simple example of how to use the TranJS framework.
* Supported drivers are available at [here](/docs/drivers.md).

If you have any questions or need help, just ask!

## Installation

It should be set up for the database you want to use. See [here](/docs/drivers.md).

Also, you can refer to the [self-implementation](/docs/self-implement-guide.md) guide if you want to implement the driver yourself.

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

## The reason why made this
While developing software requiring robust transaction management, I needed a way to group multiple query executions into a single transaction. Initially, I used anonymous functions, referred to as _Executables_, to achieve this. However, this approach was complex, required extra boilerplate code, and made it difficult for new developers to understand.

To simplify this process, I created **tranjs**, a framework that enables transaction management in Node.js using a clean and intuitive `@Transactional` decorator, inspired by Java Hibernate.

## LICENSE

This project is licensed under the LGPL-2.1 License - see the [LICENSE](LICENSE) file for details.
