import { transactional, TransactionConfig } from "@tranjs/core";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

const identity = transactional(async <T>(value: T): Promise<T> => value);
const identityResult = identity({ id: 1, name: "identity" });
export type GenericAsyncIdentity = Expect<Equal<typeof identityResult, Promise<{ id: number; name: string }>>>;
const explicitIdentity = identity<string>("value");
export type ExplicitGenericIdentity = Expect<Equal<typeof explicitIdentity, Promise<string>>>;

const constrained = transactional(async <T extends { id: number }>(value: T): Promise<T> => value);
const constrainedResult = constrained({ id: 1, extra: true });
export type ConstrainedGeneric = Expect<Equal<typeof constrainedResult, Promise<{ id: number; extra: boolean }>>>;
// @ts-expect-error The original generic constraint is retained.
constrained({ id: "wrong" });

const receiver = transactional(function(this: { prefix: string }, value: number): string {
    return this.prefix + value;
});
export type ExplicitReceiver = Expect<Equal<ThisParameterType<typeof receiver>, { prefix: string }>>;
export type ReceiverArguments = Expect<Equal<Parameters<typeof receiver>, [value: number]>>;
export type ReceiverReturn = Expect<Equal<ReturnType<typeof receiver>, Promise<string>>>;
void receiver.call({ prefix: "id:" }, 1);
// @ts-expect-error The required receiver must not disappear.
receiver(1);
// @ts-expect-error Receiver shape remains checked.
receiver.call({ prefix: 1 }, 1);

const optionalRest = transactional((first: string, optional?: number, ...flags: boolean[]) => ({ first, optional, flags }));
export type OptionalRestArguments = Expect<Equal<Parameters<typeof optionalRest>, [first: string, optional?: number, ...flags: boolean[]]>>;
void optionalRest("one");
void optionalRest("one", undefined, true, false);
// @ts-expect-error Rest element types are preserved.
optionalRest("one", 1, "wrong");

const sync = transactional((value: number): 7 => 7);
export type SyncReturn = Expect<Equal<ReturnType<typeof sync>, Promise<7>>>;
const thenable = transactional((value: PromiseLike<PromiseLike<7>>) => value);
export type ThenableReturn = Expect<Equal<ReturnType<typeof thenable>, Promise<7>>>;
const union = transactional((value: string | PromiseLike<number>) => value);
export type AwaitedUnionReturn = Expect<Equal<ReturnType<typeof union>, Promise<string | number>>>;
const noReturn = transactional(() => {});
export type VoidReturn = Expect<Equal<ReturnType<typeof noReturn>, Promise<void>>>;

export function forwarding<R>(fn: () => R, config: TransactionConfig): Promise<Awaited<R>> {
    return transactional(fn, config)();
}
