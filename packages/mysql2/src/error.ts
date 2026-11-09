import { IsolationLevel } from "@tranjs/core";

/** MySQL isolation settings cannot be applied safely through Hyperdrive. */
export class UnsupportedIsolationLevelError extends Error {
    constructor(public readonly isolationLevel: IsolationLevel) {
        super(`MySQL isolation level ${isolationLevel} is unsupported: isolation levels are silently ignored through Cloudflare Hyperdrive. Use isolationLevel: "apply" only for direct MySQL connections.`);
        this.name = "UnsupportedIsolationLevelError";
    }
}
