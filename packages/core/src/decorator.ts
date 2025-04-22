import { GlobalTransactionManager } from "./manager";
import { Propagation } from "./propagation";
import { DatasourceSetupError } from "./error";

export type PromiseMethodDecorator = <T>(target: any, propertyKey: (string | symbol), descriptor: TypedPropertyDescriptor<(...args: any[]) => Promise<T>>) => (void | TypedPropertyDescriptor<(...args: any[]) => Promise<T>>);

/**
 * Transactional decorator. Before invoking the method with this decorator, datasource should be set up. use `useTransactionManager()`.
 * Only works with async methods.
 * @param {Propagation} propagation
 */
export function Transactional(propagation: Propagation = Propagation.REQUIRED): PromiseMethodDecorator {
    return function <T>(
        target: any,
        propertyKey: string | symbol,
        descriptor: TypedPropertyDescriptor<(...args: any[]) => Promise<T>>
    ): TypedPropertyDescriptor<(...args: any[]) => Promise<T>> | void {
        const originalMethod = descriptor.value!;

        descriptor.value = async function (...args: any[]): Promise<T> {
            if (!GlobalTransactionManager) throw new DatasourceSetupError;
            return GlobalTransactionManager.executeTransaction(
                propagation,
                async (tx) => await originalMethod.apply(this, args),
            );
        };

        return descriptor;
    };
}