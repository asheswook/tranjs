import {Pool} from "mysql2/promise";
import {MySQLConnection} from "./context";
import {
    createQueryDecorator,
    createTransactionDecorator,
    Propagation,
    PlatformTransactionManager, TransactionContext, ParamDecorator
} from "@tranjs/core";
import {MySQLQueryParser} from "./query";
import {MySQLTransactionManager} from "./manager";

let manager: PlatformTransactionManager<MySQLConnection>
let Transactional: (propagation?: Propagation) => MethodDecorator;
let Query: (query: string) => any;
const Param = ParamDecorator;

/**
 * Use the pool to globally manage transactions (for tranjs)
 * @param pool
 */
function usePool(pool: Pool): void {
    manager = new MySQLTransactionManager(pool);
    Transactional = createTransactionDecorator(manager);
    Query = createQueryDecorator(manager, new MySQLQueryParser());
}

/**
 * Get the current transaction context
 * @return {TransactionContext}
 */
function getCurrentTransaction(): TransactionContext {
    // don't need to check for null, as it's guaranteed to be set by transaction decorator
    return manager.getCurrentTransaction()!;
}

export * from "mysql2/promise";
export { Transactional, Query, Param, usePool, getCurrentTransaction };