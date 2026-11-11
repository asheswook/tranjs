import { DatabaseError, Pool } from "pg";
import { testConnectionContract } from "../../../scripts/test/test-connection-contract";
import { ctx, PostgreSQLClientPerTransactionManager, PostgreSQLTransactionManager } from "../src";

const url = process.env.PG_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";

for (const mode of ["pool", "per-transaction"]) {
    testConnectionContract(`pg-${mode}`, ({ maxConnections }) => {
        const pool = new Pool({ connectionString: url, max: maxConnections });
        const manager = () => mode === "pool"
            ? new PostgreSQLTransactionManager(pool)
            : new PostgreSQLClientPerTransactionManager({ connectionString: url });
        return {
            kind: "pg", manager: manager(), otherManager: manager(), ambient: ctx,
            outside: text => pool.query(text), rows: result => result.rows,
            query: (db, text, values) => db.query(text, values),
            close: () => pool.end(),
            nativeError: error => {
                expect(error).toBeInstanceOf(DatabaseError);
                expect(error).toMatchObject({ code: "23505" });
            },
        };
    });
}
