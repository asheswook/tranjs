import { AsyncResource } from "node:async_hooks";
import { Pool } from "pg";
import { createPool } from "mysql2/promise";
import {
    clearTransactionManager, transactional, TransactionClosedError,
    TransactionContextMixingError, useTransactionManager,
} from "@tranjs/core";
import {
    ctx as mysqlContext, MySQLConnectionPerTransactionManager, MySQLTransactionManager,
} from "@tranjs/mysql2";
import { ctx as pgContext, PostgreSQLClientPerTransactionManager, PostgreSQLTransactionManager } from "../src";

describe.each(["pool", "per-transaction"])("pg/mysql2 context mixing / %s (real databases)", mode => {
    const pgURL = process.env.PG_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
    const mysqlURL = process.env.MYSQL_URL ?? "mysql://root:root@localhost:3306/test";
    const pgPool = new Pool({ connectionString: pgURL, max: 1 });
    const mysqlPool = createPool({ uri: mysqlURL, connectionLimit: 1 });
    const pgName = Symbol("context-mixing-pg");
    const mysqlName = Symbol("context-mixing-mysql2");
    const contexts: Array<(datasource?: string | symbol) => { query(sql: string): PromiseLike<unknown> }> = [pgContext, mysqlContext];
    const names = [pgName, mysqlName];

    beforeAll(() => {
        useTransactionManager(mode === "pool" ? new PostgreSQLTransactionManager(pgPool)
            : new PostgreSQLClientPerTransactionManager({ connectionString: pgURL }), pgName);
        useTransactionManager(mode === "pool" ? new MySQLTransactionManager(mysqlPool)
            : new MySQLConnectionPerTransactionManager({ uri: mysqlURL }), mysqlName);
    });
    afterAll(async () => {
        clearTransactionManager(pgName);
        clearTransactionManager(mysqlName);
        await Promise.all([pgPool.end(), mysqlPool.end()]);
    });

    it.each([0, 1])("rejects the outer driver's implicit lookup while driver %s is outermost", async outerIndex => {
        const innerIndex = 1 - outerIndex;
        const outerContext = contexts[outerIndex];
        const innerContext = contexts[innerIndex];
        let retained!: () => unknown;
        await transactional(async () => {
            const outer = outerContext();
            await transactional(async () => {
                expect(() => outerContext()).toThrow(TransactionContextMixingError);
                expect(() => outerContext(names[innerIndex])).toThrow(TransactionContextMixingError);
                expect(outerContext(names[outerIndex])).toBe(outer);
                await innerContext().query("SELECT 1");
                await outer.query("SELECT 1");
                retained = AsyncResource.bind(outerContext);
            }, { datasource: names[innerIndex] })();
            expect(retained).toThrow(TransactionClosedError);
            expect(outerContext()).toBe(outer);
            await outer.query("SELECT 1");
        }, { datasource: names[outerIndex] })();
        expect(retained).toThrow(TransactionClosedError);
    });
});
