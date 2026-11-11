import "./bridge";
import { executeTestConnection } from "@tranjs/core/internal/testing-bridge";
import type { TestOptions } from "./options";

export function withTestConnection<C, R>(fn: (db: C) => R, options: TestOptions = {}): Promise<Awaited<R>> {
    return executeTestConnection(fn, options.datasource);
}
