import { ctx, usePostgreSQLTransactionManager } from "@tranjs/pg";
import { Pool } from "pg";
import { IllegalTransactionStateException, Propagation, Transactional } from "@tranjs/core";

const pool = new Pool({
    host: 'localhost',
})

usePostgreSQLTransactionManager(pool)

interface UserDTO {
    id: string;
    balance: number;
}

class MyService {
    @Transactional(Propagation.REQUIRES_NEW) // Must be start new transaction for transfer
    async transfer(from: string, to: string, amount: number) {
        await this.withdrawMoney("Jaewook", 100);
        await this.depositMoney("Chansu", 100);
    }

    @Transactional(Propagation.MANDATORY) // Must be join transaction
    async depositMoney(userId: string, amount: number) {
        await ctx().query("UPDATE users SET balance = balance + $1 WHERE id = $2", [amount, userId]);
    }

    @Transactional(Propagation.MANDATORY) // Must be join transaction
    async withdrawMoney(userId: string, amount: number) {
        await ctx().query("UPDATE users SET balance = balance - $1 WHERE id = $2", [amount, userId]);
    }

    @Transactional() // Default Propagation.REQUIRED
    async getBalance(userId: string): Promise<number | null> {
        const result = await ctx().query<UserDTO>("SELECT id, balance from users WHERE id = $1", [userId]);
        return result.rows[0]?.balance ?? null;
    }
}

const service = new MyService();

async function main() {
    await service.transfer("Jaewook", "Chansu", 100);

    console.log(await service.getBalance("Jaewook"));
    console.log(await service.getBalance("Chansu"));

    // 트랜잭션 없이 호출하면 IllegalTransactionStateException 발생 (MANDATORY)
    await service.withdrawMoney("Jaewook", 100).catch((e) => {
        if (e instanceof IllegalTransactionStateException) {
            console.log("Illegal Transaction State Exception: ", e.message);
        }
    })

    await pool.end();
}

main()
