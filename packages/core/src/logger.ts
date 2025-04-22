export interface Logger {
    /**
     * Log a message at the `info` level.
     */
    info(message: string, ...args: any[]): void;

    /**
     * Log a message at the `warn` level.
     */
    warn(message: string, ...args: any[]): void;

    /**
     * Log a message at the `error` level.
     */
    error(message: string, ...args: any[]): void;

    /**
     * Log a message at the `debug` level.
     */
    debug(message: string, ...args: any[]): void;
}

export class DefaultLogger implements Logger {
    info(message: string, ...args: any[]): void {
        console.log(message, ...args);
    }

    warn(message: string, ...args: any[]): void {
        console.warn(message, ...args);
    }

    error(message: string, ...args: any[]): void {
        console.error(message, ...args);
    }

    debug(message: string, ...args: any[]): void {
        console.debug(message, ...args);
    }
}