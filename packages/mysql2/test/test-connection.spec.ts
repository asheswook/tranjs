import { createPool } from "mysql2/promise";
import { testConnectionContract } from "../../../scripts/test/test-connection-contract";
import { ctx, MySQLConnectionPerTransactionManager, MySQLTransactionManager } from "../src";

const url = process.env.MYSQL_URL ?? "mysql://root:root@localhost:3306/test";

for (const mode of ["pool", "per-transaction"]) {
    testConnectionContract(`mysql2-${mode}`, ({ maxConnections }) => {
        const pool = createPool({ uri: url, connectionLimit: maxConnections });
        const manager = () => mode === "pool"
            ? new MySQLTransactionManager(pool)
            : new MySQLConnectionPerTransactionManager({ uri: url });
        return {
            kind: "mysql2", manager: manager(), otherManager: manager(), ambient: ctx,
            outside: text => pool.query(text), rows: result => result[0],
            query: (db, text, values) => db.query(text, values),
            close: () => pool.end(),
            nativeError: error => { expect(error).toMatchObject({ code: "ER_DUP_ENTRY" }); },
        };
    });
}
