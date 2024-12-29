import { TransactionManager } from "./manager";
import { Propagation } from "./propagation";

export function createTransactionDecorator(transactionManager: TransactionManager<any>) {
    return function Transactional(propagation: Propagation = Propagation.REQUIRED): MethodDecorator {
        return function (
            target: any,
            propertyKey: string | symbol,
            descriptor: PropertyDescriptor
        ) {
            const originalMethod = descriptor.value;

            descriptor.value = async function (...args: any[]) {
                return transactionManager.executeTransaction(
                    async (tx) => await originalMethod.apply(this, args),
                    propagation
                );
            };

            return descriptor;
        };
    };
}