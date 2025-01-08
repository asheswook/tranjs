import {Connection, Pool, PoolOptions} from "mysql2/promise";
import * as mysql from "mysql2/promise";
import {MySQLConnection, MySQLUnitOfWork} from "./unitOfWork";
import {
    AbstractUnitOfWork, createQueryDecorator,
    createTransactionDecorator,
    GlobalAsyncLocalStorage,
    Propagation,
    TransactionManager
} from "@node-transaction/core";
import {MySQLQueryParser} from "./query";

let uow: MySQLUnitOfWork;
let manager: TransactionManager<MySQLConnection>
let Transactional: (propagation?: Propagation) => MethodDecorator;
let Query: (query: string) => any;

function ConnectionProxy(connection: Connection) {
    console.log("ConnectionProxy");
    return new Proxy(connection, {
        get(target: Connection, p: string | symbol, receiver: any): any {
            switch (p) {
                case 'execute':
                    return async (sql: mysql.QueryOptions, params?: any[] | undefined) => {
                        // 현재 트랜잭션이 실행되었는지 Context를 가져와야함...
                        // 1. 만약 @transactional 안해서 context가 안만들어져 있어도 그냥 실행
                        // 2. 만약 @transactional로 실행되었으면 context를 가져와서 실행
                        console.log('Intercepted SQL in Connection:', sql);
                        console.log('With Params:', params);

                        const tx = GlobalAsyncLocalStorage.Context as MySQLConnection;
                        if (tx) {
                            const conn = tx.connection
                            console.log("execute with transaction")
                            const result = await conn.execute.call(conn, sql, params);
                            console.log('Result from Connection:', result);
                            return result;
                        }

                        const result = await target.execute.call(target, sql, params);
                        console.log('Result from Connection:', result);

                        return result;
                    };
                default:
                    return Reflect.get(target, p, receiver);
            }
        }
    });
}

function PoolProxy(pool: Pool) {
    console.log("PoolProxy");
    return new Proxy(pool, {
        get(target: Pool, p: string | symbol, receiver: any): any {
            switch (p) {
                case 'getConnection':
                    console.log("getConnection");
                    return async () => {
                        const conn = await target.getConnection();
                        console.log("getConnection Fake");
                        return ConnectionProxy(conn);
                    };
                default:
                    return Reflect.get(target, p, receiver);
            }
        }
    });
}

// override mysql2 createConnection
export async function createConnection(connectionUri: string): Promise<Connection> {
    const conn = await mysql.createConnection(connectionUri);
    return ConnectionProxy(conn);
}

// override mysql2 createPool
export function createPool(config: PoolOptions): Pool {
    const pool = mysql.createPool(config);
    uow = new MySQLUnitOfWork(pool)
    manager = new TransactionManager(uow);
    Transactional = createTransactionDecorator(manager);
    Query = createQueryDecorator(manager, new MySQLQueryParser());
    return PoolProxy(pool);
}

export * from "mysql2/promise";
export { Transactional, Query };