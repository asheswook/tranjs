describe("core testing bridge compatibility", () => {
    afterEach(() => {
        jest.dontMock("@tranjs/core/internal/testing-bridge");
    });

    it.each([
        { TESTING_BRIDGE_VERSION: 2, TESTING_CORE_VERSION: "1.2.0" },
        { TESTING_BRIDGE_VERSION: 1, TESTING_CORE_VERSION: "1.1.0" },
        { TESTING_BRIDGE_VERSION: undefined, TESTING_CORE_VERSION: undefined },
    ])("rejects incompatible core before beginning a transaction: %p", versions => {
        const begin = jest.fn();
        jest.doMock("@tranjs/core/internal/testing-bridge", () => ({ ...versions, begin }));
        jest.isolateModules(() => {
            expect(() => require("../src")).toThrow(
                "@tranjs/testing 1.2.0 requires @tranjs/core 1.2.0 with testing bridge protocol 1",
            );
        });
        expect(begin).not.toHaveBeenCalled();
    });

    it("checks direct fixture imports before they can open a transaction", () => {
        jest.doMock("@tranjs/core/internal/testing-bridge", () => ({
            TESTING_BRIDGE_VERSION: 1, TESTING_CORE_VERSION: "2.0.0",
        }));
        jest.isolateModules(() => {
            expect(() => require("../src/fixture")).toThrow("received core 2.0.0, bridge protocol 1");
        });
    });
});
