import { executeFixture } from "../internal/fixture";

export interface FixtureOptions { datasource?: string | symbol; }

export function fixture<C, R>(fn: (ctx: C) => R, options: FixtureOptions = {}): Promise<Awaited<R>> {
    return executeFixture(fn, options.datasource);
}
