import { DatabaseError, Pool } from "pg";
import { fixtureContract } from "../../../scripts/test/fixture-contract";
import { ctx, PostgreSQLClientPerTransactionManager, PostgreSQLTransactionManager } from "../src";

const url = process.env.PG_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";

for (const mode of ["pool", "per-transaction"]) {
    fixtureContract(`pg-${mode}`, () => {
        const pool = new Pool({ connectionString: url, max: 5 });
        const manager = () => mode === "pool"
            ? new PostgreSQLTransactionManager(pool)
            : new PostgreSQLClientPerTransactionManager({ connectionString: url });
        return {
            kind: "pg", manager: manager(), otherManager: manager(), ambient: ctx,
            outside: text => pool.query(text), rows: result => result.rows,
            query: (connection, text, values) => connection.query(text, values),
            close: () => pool.end(),
            nativeError: error => {
                expect(error).toBeInstanceOf(DatabaseError);
                expect(error).toMatchObject({ code: "23505" });
            },
        };
    });
}
