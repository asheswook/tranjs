import { createPool } from "mysql2/promise";
import { fixtureContract } from "../../../scripts/test/fixture-contract";
import { ctx, MySQLConnectionPerTransactionManager, MySQLTransactionManager } from "../src";

const url = process.env.MYSQL_URL ?? "mysql://root:root@localhost:3306/test";

for (const mode of ["pool", "per-transaction"]) {
    fixtureContract(`mysql2-${mode}`, () => {
        const pool = createPool({ uri: url, connectionLimit: 5 });
        const manager = () => mode === "pool"
            ? new MySQLTransactionManager(pool)
            : new MySQLConnectionPerTransactionManager({ uri: url });
        return {
            kind: "mysql2", manager: manager(), otherManager: manager(), ambient: ctx,
            outside: text => pool.query(text), rows: result => result[0],
            query: (connection, text, values) => connection.query(text, values),
            close: () => pool.end(),
            nativeError: error => { expect(error).toMatchObject({ code: "ER_DUP_ENTRY" }); },
        };
    });
}
