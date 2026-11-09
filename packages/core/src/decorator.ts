import { runInTransaction } from "./manager";
import { Propagation } from "./propagation";
import { TransactionConfig } from "./config";

export type PromiseMethodDecorator = <T>(target: any, propertyKey: (string | symbol), descriptor: TypedPropertyDescriptor<(...args: any[]) => Promise<T>>) => (void | TypedPropertyDescriptor<(...args: any[]) => Promise<T>>);

/**
 * Transactional decorator. Before invoking the method with this decorator, datasource should be set up. use `useTransactionManager()`.
 * Only works with async methods.
 * Accepts a propagation value or a transaction configuration.
 */
export function Transactional(arg: Propagation | TransactionConfig = Propagation.REQUIRED): PromiseMethodDecorator {
    const config = typeof arg === "string" ? { propagation: arg } : { ...arg };
    return function <T>(
        target: any,
        propertyKey: string | symbol,
        descriptor: TypedPropertyDescriptor<(...args: any[]) => Promise<T>>
    ): TypedPropertyDescriptor<(...args: any[]) => Promise<T>> | void {
        const originalMethod = descriptor.value!;

        descriptor.value = async function (...args: any[]): Promise<T> {
            return runInTransaction(() => originalMethod.apply(this, args), config);
        };
        Object.defineProperty(descriptor.value, "name", { value: originalMethod.name, configurable: true });
        // reflect-metadata remains optional for applications which do not use it.
        const metadata = Reflect as typeof Reflect & {
            getMetadataKeys?: (target: object) => any[];
            getMetadata?: (key: any, target: object) => any;
            defineMetadata?: (key: any, value: any, target: object) => void;
        };
        if (metadata.getMetadataKeys && metadata.getMetadata && metadata.defineMetadata) {
            for (const key of metadata.getMetadataKeys(originalMethod)) {
                metadata.defineMetadata(key, metadata.getMetadata(key, originalMethod), descriptor.value);
            }
        }

        return descriptor;
    };
}
