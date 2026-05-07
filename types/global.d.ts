import type { Logger, LogLevel } from "@utils/logger";

declare global {
    /**
     * Global logger instance — available everywhere without import.
     *
     * @example
     * logger.log("commands/ping", "Pong!", "info");
     * logger.error("commands/ytmp4", err);
     * logger.warn("handlers/message", { jid, reason });
     */
    var logger: {
        log(source: string, message: string | object | Error, level?: LogLevel): void;
        info(source: string, message: string | object): void;
        warn(source: string, message: string | object): void;
        error(source: string, message: string | object | Error): void;
        system(source: string, message: string | object): void;
        debug(source: string, message: string | object): void;
    };
}

export { }; // Wajib — supaya file ini diperlakukan sebagai module augmentation