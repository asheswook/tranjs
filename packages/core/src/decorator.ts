import {QueryParser} from "./query";
import {GlobalTransactionManager, PlatformTransactionManager} from "./manager";
import { Propagation } from "./propagation";
import {TransactionContext} from "./context";
import 'reflect-metadata';
import {DatasourceSetupError} from "./error";

/**
 * Transactional decorator. Before invoking the method with this decorator, datasource should be set up. use `useTransactionManager()`.
 * @param {Propagation} propagation
 */
export function Transactional(propagation: Propagation = Propagation.REQUIRED): MethodDecorator {
    return function (
        target: any,
        propertyKey: string | symbol,
        descriptor: PropertyDescriptor
    ) {
        const originalMethod = descriptor.value;

        descriptor.value = async function (...args: any[]) {
            if (!GlobalTransactionManager) throw new DatasourceSetupError;
            return GlobalTransactionManager.executeTransaction(
                propagation,
                async (tx) => await originalMethod.apply(this, args),
            );
        };

        return descriptor;
    };
}

/**
 * @experimental
 */
export function createTransactionDecorator(transactionManager: PlatformTransactionManager<TransactionContext>) {
    return function (propagation: Propagation = Propagation.REQUIRED): MethodDecorator {
        return function (
            target: any,
            propertyKey: string | symbol,
            descriptor: PropertyDescriptor
        ) {
            const originalMethod = descriptor.value;

            descriptor.value = async function (...args: any[]) {
                return transactionManager.executeTransaction(
                    propagation,
                    async (tx) => await originalMethod.apply(this, args),
                );
            };

            return descriptor;
        };
    };
}

/**
 * @experimental
 */
const QueryParamKey = Symbol("QueryParam");

/**
 * @experimental
 */
interface QueryParameter {
    index: number;
    name: string;
}


/**
 * @experimental
 */
export function createQueryDecorator(transactionManager: PlatformTransactionManager<TransactionContext>, parser: QueryParser) {
    return function (query: string) {
        return function <T extends Function>(target: Object, propertyKey: string | symbol, descriptor: TypedPropertyDescriptor<T>): void {
            const q = parser.parse(query);
            const method = descriptor.value!;

            descriptor.value = async function (this: any, ...args: any[]) {
                const params: QueryParameter[] = Reflect.getOwnMetadata(QueryParamKey, target, propertyKey);
                if (q.paramNames.length !== params.length) {
                    throw new Error("Parameter count mismatch");
                }

                if (args.length !== params.length) {
                    throw new Error("Argument count mismatch");
                }

                for (const param of params) {
                    if (param.name !== q.paramNames[param.index]) {
                        throw new Error("Parameter name mismatch" + param.name + " " + q.paramNames[param.index]);
                    }
                }

                const context = transactionManager.getCurrentTransaction()
                if (!context) throw new Error("No transaction context found");

                return await context.execute(q.query, args);
            } as any;
        }
    }
}

/**
 * @experimental
 */
export function ParamDecorator(key: string): ParameterDecorator {
    return (target: Object, propertyKey: string | symbol | undefined, parameterIndex: number): void => {
        const params: QueryParameter[] = Reflect.getOwnMetadata(QueryParamKey, target, propertyKey!) || [];
        params.push({ index: parameterIndex, name: key });
        Reflect.defineMetadata(QueryParamKey, params, target, propertyKey!);
    }
}