import { matchers } from "../src";
import { expect as runnerExpect } from "@jest/globals";
import * as jestEntry from "../src/jest";

it("exposes only matchers from the Jest entry", () => {
    expect(Object.keys(jestEntry)).toEqual(["matchers"]);
    expect(jestEntry.matchers).toBe(matchers);
});

it("registers all six matchers on the runner's imported expect", () => {
    for (const name of Object.keys(matchers)) {
        expect(typeof (runnerExpect(() => {}) as any)[name]).toBe("function");
    }
});
