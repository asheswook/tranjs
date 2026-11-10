import { ctx, usePostgreSQLTransactionManager } from "@tranjs/pg";
import { Pool } from "pg";
import {
    IllegalTransactionStateException,
    Propagation,
    transactional,
    Transactional,
} from "@tranjs/core";

// Defaults match the repository's docker-compose.yml; override with PG_URL.
const pool = new Pool({
    connectionString: process.env.PG_URL ?? "postgres://postgres:postgres@localhost:5432/postgres",
});

// Register once, outside request handlers and transactional methods.
usePostgreSQLTransactionManager(pool);

interface UserDTO {
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
        await ctx().query(
            "UPDATE tranjs_example_users SET balance = balance + $1 WHERE id = $2",
            [amount, userId],
        );
    }

    @Transactional(Propagation.MANDATORY)
    async withdrawMoney(userId: string, amount: number): Promise<void> {
        await ctx().query(
            "UPDATE tranjs_example_users SET balance = balance - $1 WHERE id = $2",
            [amount, userId],
        );
    }

    @Transactional() // REQUIRED: join a transaction, or begin one.
    async getBalance(userId: string): Promise<number | null> {
        const { rows } = await ctx().query<UserDTO>(
            "SELECT id, balance FROM tranjs_example_users WHERE id = $1", [userId],
        );
        return rows[0]?.balance ?? null;
    }
}

async function main(): Promise<void> {
    try {
        await transactional(async () => {
            await ctx().query(`CREATE TABLE IF NOT EXISTS tranjs_example_users (
                id TEXT PRIMARY KEY,
                balance INTEGER NOT NULL
            )`);
            await ctx().query(`INSERT INTO tranjs_example_users (id, balance)
                VALUES ('Jaewook', 1000), ('Chansu', 1000)
                ON CONFLICT (id) DO UPDATE SET balance = EXCLUDED.balance`);
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
