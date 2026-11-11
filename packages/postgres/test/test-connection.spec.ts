import postgres from "postgres";
import { testConnectionContract } from "../../../scripts/test/test-connection-contract";
import { ctx, PostgresConnectionPerTransactionManager, PostgresTransactionManager } from "../src";

const url = process.env.PG_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";

// postgres-v3.cjs copies this test and the shared scripts/test harness, and
// redirects every postgres import (including per-transaction native imports).
for (const mode of ["pool", "per-transaction"]) {
    testConnectionContract(`postgres-${mode}`, ({ maxConnections }) => {
        const sql = postgres(url, { max: maxConnections, onnotice: false });
        const manager = () => mode === "pool"
            ? new PostgresTransactionManager(sql)
            : new PostgresConnectionPerTransactionManager(url);
        return {
            kind: "postgres", manager: manager(), otherManager: manager(), ambient: ctx,
            outside: async text => sql.unsafe(text), rows: result => Array.from(result),
            query: (db, text, values) => db.unsafe(text, values),
            close: async () => { await sql.end(); },
            nativeError: error => {
                expect(error).toBeInstanceOf(postgres.PostgresError);
                expect(error).toMatchObject({ code: "23505" });
            },
        };
    });
}
