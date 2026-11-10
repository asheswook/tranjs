import { currentTestSession, TestBoundaryInfo, TestSession } from "../internal";

/** Private matcher evidence. No runner dependencies and no production allocations. */
export interface RecordedCall {
    readonly sequence: number;
    readonly transaction?: TestBoundaryInfo;
    readonly afterCommitOf?: TestBoundaryInfo;
}
export interface TrackedFunction {
    readonly owner: object;
    propertyName?: string;
    readonly name: string;
    readonly calls: RecordedCall[];
    readonly completions: WeakMap<TestBoundaryInfo, { sequence: number; outcome: TestBoundaryInfo["outcome"] }>;
}
const wrappers = new WeakMap<Function, TrackedFunction>();
const originals = new WeakMap<Function, {
    entries: WeakMap<object, TrackedFunction>;
    single?: TrackedFunction;
    ambiguous: boolean;
}>();
const owners = new WeakMap<TestSession, object>();

export function registerProbeOwner(session: TestSession, owner: object): void {
    owners.set(session, owner);
}

export function trackedFunctionForOwner(fn: Function, owner: object): TrackedFunction | undefined {
    const wrapped = wrappers.get(fn);
    if (wrapped && wrapped.owner !== owner) {
        throw new TypeError("Cannot track a wrapper belonging to a different transaction probe; track the original function instead");
    }
    return wrapped ?? originals.get(fn)?.entries.get(owner);
}

export function registerTrackedFunction(original: Function, wrapper: Function, entry: TrackedFunction): void {
    // Never replace evidence on an original or wrapper identity. Each original
    // has a separate entry per probe, including frozen functions and methods.
    let record = originals.get(original);
    if (!record) {
        record = { entries: new WeakMap(), single: entry, ambiguous: false };
        originals.set(original, record);
    }
    if (!record.entries.has(entry.owner)) {
        if (record.single && record.single.owner !== entry.owner) {
            record.single = undefined;
            record.ambiguous = true;
        }
        record.entries.set(entry.owner, entry);
    }
    wrappers.set(wrapper, entry);
}

export function getTrackedFunction(fn: Function): TrackedFunction | undefined {
    const wrapped = wrappers.get(fn);
    if (wrapped) return wrapped;
    const record = originals.get(fn);
    if (!record) return undefined;
    const session = currentTestSession();
    const owner = session && owners.get(session);
    if (session && !session.closed) {
        const entry = owner && record.entries.get(owner);
        if (!entry) throw new TypeError("Original function was not tracked by the current transaction probe; use its tracked wrapper");
        return entry;
    }
    if (record.ambiguous) {
        throw new TypeError("Original function belongs to multiple transaction probes; use its tracked wrapper outside an active session");
    }
    // A dangling task must not borrow even a sole entry from another session.
    if (session && record.single?.owner !== owner) {
        throw new TypeError("Original function was not tracked by the current transaction probe; use its tracked wrapper");
    }
    return record.single;
}
