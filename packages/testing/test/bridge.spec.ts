describe("core testing bridge compatibility", () => {
    afterEach(() => {
        jest.dontMock("@tranjs/core/internal/testing-bridge");
    });

    it.each([0, 2, undefined])("rejects incompatible protocol before beginning a transaction: %p", version => {
        const begin = jest.fn();
        jest.doMock("@tranjs/core/internal/testing-bridge", () => ({ TESTING_BRIDGE_VERSION: version, begin }));
        jest.isolateModules(() => {
            expect(() => require("../src")).toThrow(
                "@tranjs/testing requires testing bridge protocol 1",
            );
        });
        expect(begin).not.toHaveBeenCalled();
    });

    it("checks direct fixture imports before they can open a transaction", () => {
        const begin = jest.fn();
        jest.doMock("@tranjs/core/internal/testing-bridge", () => ({
            TESTING_BRIDGE_VERSION: 2, begin,
        }));
        jest.isolateModules(() => {
            expect(() => require("../src/fixture")).toThrow("received protocol 2");
        });
        expect(begin).not.toHaveBeenCalled();
    });
});
