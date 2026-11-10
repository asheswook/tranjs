import { matchers } from "../src/testing";
import * as jestEntry from "../src/testing/jest";

it("exposes only matchers from the Jest entry", () => {
    expect(Object.keys(jestEntry)).toEqual(["matchers"]);
    expect(jestEntry.matchers).toBe(matchers);
});
