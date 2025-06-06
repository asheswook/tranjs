import { ctx, useMySQLTransactionManager } from "@tranjs/mysql2";
import { createPool, RowDataPacket } from "mysql2/promise";
import { IllegalTransactionStateException, Propagation, Transactional } from "@tranjs/core";

const pool = createPool({
    host: 'localhost',
})

useMySQLTransactionManager(pool)

interface UserDTO extends RowDataPacket {
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
        await ctx().execute("UPDATE user SET balance = balance + ? WHERE id = ?", [amount, userId]);
    }

    @Transactional(Propagation.MANDATORY) // Must be join transaction
    async withdrawMoney(userId: string, amount: number) {
        await ctx().execute("UPDATE user SET balance = balance - ? WHERE id = ?", [amount, userId]);
    }

    @Transactional() // Default Propagation.REQUIRED
    async getBalance(userId: string): Promise<number | null> {
        const [rows] = await ctx().execute<UserDTO[]>("SELECT id, balance from user WHERE id = ?", [userId]);
        return rows[0]?.balance ?? null;
    }
}

const service = new MyService();

async function main() {
    await service.transfer("Jaewook", "Chansu", 100);

    console.log(await service.getBalance("Jaewook"));
    console.log(await service.getBalance("Chansu"));

    // Illegal Transaction Exception (MANDATORY)
    await service.withdrawMoney("Jaewook", 100).catch((e) => {
        if (e instanceof IllegalTransactionStateException) {
            console.log("Illegal Transaction State Exception: ", e.message);
        }
    })

    pool.end();
}

main()