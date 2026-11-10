import { ctx, useMySQLTransactionManager } from "@tranjs/mysql2";
import { createPool, RowDataPacket } from "mysql2/promise";
import {
    IllegalTransactionStateException,
    Propagation,
    transactional,
    Transactional,
} from "@tranjs/core";

// Defaults match the repository's docker-compose.yml; override with MYSQL_URL.
const pool = createPool(process.env.MYSQL_URL ?? "mysql://root:root@localhost:3306/test");

// Register once, outside request handlers and transactional methods.
useMySQLTransactionManager(pool);

interface UserDTO extends RowDataPacket {
    id: string;
    balance: number;
}

class MyService {
    // Always use an independent transaction, even if the caller has one.
    @Transactional(Propagation.REQUIRES_NEW)
    async transfer(from: string, to: string, amount: number): Promise<void> {
        await this.withdrawMoney(from, amount);
        await this.depositMoney(to, amount);
    }

    // Join the transfer's transaction; reject calls without one.
    @Transactional(Propagation.MANDATORY)
    async depositMoney(userId: string, amount: number): Promise<void> {
        await ctx().execute(
            "UPDATE tranjs_example_users SET balance = balance + ? WHERE id = ?",
            [amount, userId],
        );
    }

    @Transactional(Propagation.MANDATORY)
    async withdrawMoney(userId: string, amount: number): Promise<void> {
        await ctx().execute(
            "UPDATE tranjs_example_users SET balance = balance - ? WHERE id = ?",
            [amount, userId],
        );
    }

    @Transactional() // REQUIRED: join a transaction, or begin one.
    async getBalance(userId: string): Promise<number | null> {
        const [rows] = await ctx().execute<UserDTO[]>(
            "SELECT id, balance FROM tranjs_example_users WHERE id = ?", [userId],
        );
        return rows[0]?.balance ?? null;
    }
}

async function main(): Promise<void> {
    try {
        // MySQL DDL can commit implicitly, so create the table before the transaction.
        await pool.query(`CREATE TABLE IF NOT EXISTS tranjs_example_users (
            id VARCHAR(100) PRIMARY KEY,
            balance INTEGER NOT NULL
        ) ENGINE=InnoDB`);
        await transactional(async () => {
            await ctx().query(`INSERT INTO tranjs_example_users (id, balance)
                VALUES ('Jaewook', 1000), ('Chansu', 1000)
                ON DUPLICATE KEY UPDATE balance = 1000`);
        })();

        const service = new MyService();
        await service.transfer("Jaewook", "Chansu", 100);
        console.log("Jaewook:", await service.getBalance("Jaewook")); // 900
        console.log("Chansu:", await service.getBalance("Chansu")); // 1100

        // MANDATORY rejects this call because no transaction is active.
        try {
            await service.withdrawMoney("Jaewook", 100);
        } catch (error) {
            if (!(error instanceof IllegalTransactionStateException)) throw error;
            console.log(error.message);
        }
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
