import { matchers } from "../src";
import * as jestEntry from "../src/jest";

it("exposes only matchers from the Jest entry", () => {
    expect(Object.keys(jestEntry)).toEqual(["matchers"]);
    expect(jestEntry.matchers).toBe(matchers);
});
