import postgres from "postgres";
import { fixtureContract } from "../../../scripts/test/fixture-contract";
import { ctx, PostgresConnectionPerTransactionManager, PostgresTransactionManager } from "../src";

const url = process.env.PG_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";

// postgres-v3.cjs copies this test and the shared scripts/test harness, and
// redirects every postgres import (including per-transaction native imports).
for (const mode of ["pool", "per-transaction"]) {
    fixtureContract(`postgres-${mode}`, () => {
        const sql = postgres(url, { max: 5, onnotice: false });
        const manager = () => mode === "pool"
            ? new PostgresTransactionManager(sql)
            : new PostgresConnectionPerTransactionManager(url);
        return {
            kind: "postgres", manager: manager(), otherManager: manager(), ambient: ctx,
            outside: async text => sql.unsafe(text), rows: result => Array.from(result),
            query: (connection, text, values) => connection.unsafe(text, values),
            close: async () => { await sql.end(); },
            nativeError: error => {
                expect(error).toBeInstanceOf(postgres.PostgresError);
                expect(error).toMatchObject({ code: "23505" });
            },
        };
    });
}
