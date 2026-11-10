import { AssertionError } from "node:assert";
import { getTrackedFunction, TrackedFunction } from "./metadata";

type MatcherName = "toRunInSameTransactionAs" | "toRunInSeparateTransactionFrom" |
    "toRunOutsideTransaction" | "toRunAfterCommitOf" | "toHaveCommitted" | "toHaveRolledBack";
type Inspected = TrackedFunction & { call: TrackedFunction["calls"][number] };
const binary = new Set<MatcherName>(["toRunInSameTransactionAs", "toRunInSeparateTransactionFrom", "toRunAfterCommitOf"]);

function inspect(name: MatcherName, operand: unknown, label: string): Inspected {
    let entry: TrackedFunction | undefined;
    try { entry = typeof operand === "function" ? getTrackedFunction(operand) : undefined; }
    catch (error) {
        if (!(error instanceof TypeError)) throw error;
        throw new TypeError(`${name}: ${label}: ${error.message}`);
    }
    if (!entry) throw new TypeError(`${name}: ${label} must be a function tracked by transactions().track or the test probe's track`);
    if (entry.calls.length === 0) {
        throw new TypeError(`${name}: ${label}: 0 calls recorded through the wrapper returned by track()`);
    }
    if (entry.calls.length !== 1) {
        throw new TypeError(`${name}: ${label} must have exactly one recorded call; received ${entry.calls.length}`);
    }
    return { ...entry, call: entry.calls[0] };
}

function describe(entry: Inspected): string {
    const { transaction, sequence, afterCommitOf } = entry.call;
    return `${entry.name} → ${transaction ? `tx#${transaction.id} (${transaction.propagation}, ${transaction.outcome})` : "outside transaction"}, event ${sequence}${afterCommitOf ? ", afterCommit callback" : ""}`;
}

function evaluate(name: MatcherName, received: unknown, other?: unknown) {
    const a = inspect(name, received, "received");
    const b = binary.has(name) ? inspect(name, other, "other") : undefined;
    if (b && a.owner !== b.owner) throw new TypeError(`${name}: Functions belong to different transaction probes`);
    const tx = a.call.transaction;
    const otherTx = b?.call.transaction;
    let pass: boolean;
    switch (name) {
        case "toRunInSameTransactionAs": pass = !!tx && tx === otherTx; break;
        case "toRunInSeparateTransactionFrom": pass = !!tx && !!otherTx && tx !== otherTx; break;
        case "toRunOutsideTransaction": pass = !tx; break;
        case "toHaveCommitted": pass = tx?.outcome === "committed"; break;
        case "toHaveRolledBack": pass = tx?.outcome === "rolled-back"; break;
        case "toRunAfterCommitOf": {
            const completed = otherTx && a.completions.get(otherTx);
            pass = !!otherTx && !tx && completed?.outcome === "committed" &&
                completed.sequence < a.call.sequence && a.call.afterCommitOf === otherTx;
            break;
        }
    }
    return {
        pass,
        message: (negated = false) => `Expected tracked function ${negated ? "not " : ""}${name}${b ? "(other)" : "()"}\nReceived: ${describe(a)}${b ? `\nOther: ${describe(b)}` : ""}${name === "toRunAfterCommitOf" ? "\nRequires an observed afterCommit callback for the committed transaction (later outside calls do not qualify)." : ""}`,
    };
}

function assertion(name: MatcherName, received: unknown, other?: unknown): void {
    const result = evaluate(name, received, other);
    if (!result.pass) throw new AssertionError({ message: result.message(), operator: name, actual: received, expected: other });
}

/** Assert one recorded call per operand in the same transaction test session. */
export function assertSameTransaction(a: Function, b: Function): void { assertion("toRunInSameTransactionAs", a, b); }
export function assertSeparateTransaction(a: Function, b: Function): void { assertion("toRunInSeparateTransactionFrom", a, b); }
export function assertOutsideTransaction(a: Function): void { assertion("toRunOutsideTransaction", a); }
export function assertAfterCommitOf(a: Function, b: Function): void { assertion("toRunAfterCommitOf", a, b); }
export function assertCommitted(a: Function): void { assertion("toHaveCommitted", a); }
export function assertRolledBack(a: Function): void { assertion("toHaveRolledBack", a); }

function matcher(name: MatcherName, assert: (...args: any[]) => void) {
    return function(this: { isNot?: boolean }, received: unknown, other?: unknown) {
        // Only assertion failures become a negative result. Usage errors must
        // throw even under .not: missing evidence is never a passing assertion.
        try { assert(received, other); }
        catch (error) {
            if (!(error instanceof AssertionError)) throw error;
            const message = error.message;
            return { pass: false, message: () => this?.isNot ? message.replace("Expected tracked function ", "Expected tracked function not ") : message };
        }
        const result = evaluate(name, received, other);
        return { pass: true, message: () => result.message(this?.isNot) };
    };
}

export const toRunInSameTransactionAs = matcher("toRunInSameTransactionAs", assertSameTransaction);
export const toRunInSeparateTransactionFrom = matcher("toRunInSeparateTransactionFrom", assertSeparateTransaction);
export const toRunOutsideTransaction = matcher("toRunOutsideTransaction", assertOutsideTransaction);
export const toRunAfterCommitOf = matcher("toRunAfterCommitOf", assertAfterCommitOf);
export const toHaveCommitted = matcher("toHaveCommitted", assertCommitted);
export const toHaveRolledBack = matcher("toHaveRolledBack", assertRolledBack);

/** Framework-neutral: pass to Jest or Vitest's expect.extend(). */
export const matchers = {
    toRunInSameTransactionAs, toRunInSeparateTransactionFrom, toRunOutsideTransaction,
    toRunAfterCommitOf, toHaveCommitted, toHaveRolledBack,
};
