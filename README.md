# TranJS

[![Test](https://github.com/asheswook/tranjs/actions/workflows/test.yml/badge.svg)](https://github.com/asheswook/tranjs/actions/workflows/test.yml)

TranJS is a transaction management framework which provides declaretive transaction, without any ORMs. 

It is designed to provide reliable and intuitive transaction management for mission-critical safety applications and general-purpose applications.

## Features
- ✅ **Declarative Transaction via Decorator**
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
