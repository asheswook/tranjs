import {ctx, useMySQLTransactionManager} from "@tranjs/mysql2";
import {createPool, RowDataPacket} from "mysql2/promise";
import {Propagation, Transactional} from "@tranjs/core";

const pool = createPool({
    host: 'localhost',
    user: 'root',
    password: 'dkdwodnrEl',
    database: 'tranjs',
})

useMySQLTransactionManager(pool)

interface UserDTO extends RowDataPacket {
    id: string;
    balance: number;
}

class MyService {
    @Transactional()
    async transfer(from: string, to: string, amount: number) {
        await this.withdrawMoney("Jaewook", 100);
        await this.depositMoney("Chansu", 100);
    }

    @Transactional(Propagation.MANDATORY)
    async depositMoney(userId: string, amount: number) {
        await ctx().execute("UPDATE user SET balance = balance + ? WHERE id = ?", [amount, userId]);
    }

    @Transactional(Propagation.MANDATORY)
    async withdrawMoney(userId: string, amount: number) {
        await ctx().execute("UPDATE user SET balance = balance - ? WHERE id = ?", [amount, userId]);
    }

    @Transactional()
    async getBalance(userId: string): Promise<number | null> {
        const [rows] = await ctx().execute<UserDTO[]>("SELECT id, balance from user WHERE id = ?", [userId]);
        return rows[0]?.balance ?? null;
    }
}

const service = new MyService();

async function bootstrap() {
    await service.transfer("Jaewook", "Chansu", 100);
    console.log(await service.getBalance("Jaewook"));
    console.log(await service.getBalance("Chansu"));
    // await service.withdrawMoney("Jaewook", 100); // Illegal Transaction Exception (MANDATORY)

    pool.end();
}

bootstrap()