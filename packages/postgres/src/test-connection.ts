import type postgres from "postgres" with { "resolution-mode": "import" };
import type { TestConnectionLease } from "@tranjs/core/internal/testing-bridge";
import type { ReservedTransactionSql } from "./context";

/** Eager queries only; native query modifiers and connection helpers are not exposed. */
export interface TestConnection {
    <T extends readonly (object | undefined)[] = postgres.Row[]>(
        template: TemplateStringsArray,
        ...parameters: readonly postgres.ParameterOrFragment<never>[]
    ): Promise<postgres.RowList<T>>;
    unsafe<T extends any[] = (postgres.Row & Iterable<postgres.Row>)[]>(
        text: string, values?: postgres.ParameterOrJSON<never>[],
    ): Promise<postgres.RowList<T>>;
}

export function createPostgresTestConnection(tx: ReservedTransactionSql, lease: TestConnectionLease): TestConnection {
    const tagged = <T extends readonly (object | undefined)[] = postgres.Row[]>(
        template: TemplateStringsArray,
        ...parameters: readonly postgres.ParameterOrFragment<never>[]
    ): Promise<postgres.RowList<T>> => {
        lease.assert();
        if (!Array.isArray(template) || !Array.isArray(template.raw) ||
            template.length !== parameters.length + 1 || template.raw.length !== template.length ||
            !template.every(part => typeof part === "string") ||
            !template.raw.every(part => typeof part === "string")) {
            throw new TypeError("withTestConnection connection requires a tagged SQL template");
        }
        // Calling then immediately consumes the native lazy query. Only a plain
        // Promise escapes, never a PendingQuery with modifiers or connection access.
        return lease.track(() => new Promise<postgres.RowList<T>>((resolve, reject) => {
            tx<T>(template, ...parameters).then(resolve, reject);
        }));
    };
    const unsafe = <T extends any[] = (postgres.Row & Iterable<postgres.Row>)[]>(
        ...args: [text: string, values?: postgres.ParameterOrJSON<never>[]]
    ): Promise<postgres.RowList<T>> => {
        lease.assert();
        if (args.length < 1 || args.length > 2 || typeof args[0] !== "string" ||
            (args[1] !== undefined && !Array.isArray(args[1]))) {
            throw new TypeError("withTestConnection unsafe requires SQL text and an optional parameter array");
        }
        return lease.track(() => new Promise<postgres.RowList<T>>((resolve, reject) => {
            tx.unsafe<T>(args[0], args[1]).then(resolve, reject);
        }));
    };
    return Object.assign(Object.setPrototypeOf(tagged, null), { unsafe });
}
