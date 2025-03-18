# TranJS

[![Test](https://github.com/asheswook/tranjs/actions/workflows/test.yml/badge.svg)](https://github.com/asheswook/tranjs/actions/workflows/test.yml)

TranJS is a transaction management framework which provides declaretive transaction, without any ORMs. 

It is designed to provide reliable and intuitive transaction management for mission-critical safety applications and general-purpose applications.

## Features
- ✅ **Declarative Transaction via Decorator**
- ⚡ **TypeScript Native**
- 🛠️ **No Dependencies, Lightweight (15KB)**
- 🔄 **Flexible Transaction Propagation**

## Getting Started
* API Documentation is available at [here](/docs/api.md).
* Supported drivers are available at [here](/docs/drivers.md).
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

## LICENSE

This project is licensed under the LGPL-2.1 License - see the [LICENSE](LICENSE) file for details.
