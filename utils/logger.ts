import * as fs from "fs"
import * as path from "path"

// ─── Types ────────────────────────────────────────────────────────────────────

export type LogLevel = "info" | "warn" | "error" | "system" | "debug"

export interface LogEntry {
    timestamp: string
    level: LogLevel
    source: string
    message: string | object
}

// ─── ANSI Colors ──────────────────────────────────────────────────────────────

const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"

const COLORS: Record<LogLevel, string> = {
    info: "\x1b[36m",    // Cyan
    warn: "\x1b[33m",    // Yellow
    error: "\x1b[31m",   // Red
    system: "\x1b[35m",  // Magenta
    debug: "\x1b[90m",   // Gray
}

const ICONS: Record<LogLevel, string> = {
    info: "ℹ",
    warn: "⚠",
    error: "✖",
    system: "⚙",
    debug: "◉",
}

// ─── Logger Class ─────────────────────────────────────────────────────────────

class Logger {
    private static instance: Logger
    private logDir: string
    private logStream: fs.WriteStream | null = null
    private currentLogDate: string = ""

    private constructor() {
        this.logDir = path.resolve("./logs")
        this.ensureLogDir()
        this.registerGlobalHandlers()
    }

    static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger()
        }
        return Logger.instance
    }

    // ── Core log method ─────────────────────────────────────────────────────────

    log(
        source: string,
        message: string | object | Error,
        level: LogLevel = "info"
    ): void {
        const now = new Date()
        const timestamp = this.formatTimestamp(now)
        const dateKey = this.formatDate(now)

        // Resolve message string for file
        const resolved = this.resolveMessage(message, level)

        // Console output
        this.printConsole(timestamp, level, source, resolved.display)

        // File output
        this.writeToFile(dateKey, {
            timestamp,
            level,
            source,
            message: resolved.file,
        })
    }

    // ── Convenience shorthands ──────────────────────────────────────────────────

    info(source: string, message: string | object): void {
        this.log(source, message, "info")
    }

    warn(source: string, message: string | object): void {
        this.log(source, message, "warn")
    }

    error(source: string, message: string | object | Error): void {
        this.log(source, message, "error")
    }

    system(source: string, message: string | object): void {
        this.log(source, message, "system")
    }

    debug(source: string, message: string | object): void {
        this.log(source, message, "debug")
    }

    // ── Internal helpers ────────────────────────────────────────────────────────

    private resolveMessage(
        message: string | object | Error,
        level: LogLevel
    ): { display: string; file: string } {
        if (message instanceof Error) {
            const display =
                level === "error"
                    ? `${message.message}\n${DIM}${message.stack ?? ""}${RESET}`
                    : message.message
            const file = JSON.stringify({
                name: message.name,
                message: message.message,
                stack: message.stack,
            })
            return { display, file }
        }

        if (typeof message === "string") {
            return { display: message, file: message }
        }

        // object / payload
        const pretty = JSON.stringify(message, null, 2)
        const inline = JSON.stringify(message)
        return { display: pretty, file: inline }
    }

    private printConsole(
        timestamp: string,
        level: LogLevel,
        source: string,
        display: string
    ): void {
        const color = COLORS[level]
        const icon = ICONS[level]
        const label = level.toUpperCase().padEnd(6)

        const header =
            `${DIM}${timestamp}${RESET} ` +
            `${color}${BOLD}${icon} ${label}${RESET} ` +
            `${DIM}[${source}]${RESET}`

        // Multi-line messages indent continuation lines
        const body = display.includes("\n")
            ? display
                .split("\n")
                .map((l, i) => (i === 0 ? l : `             ${l}`))
                .join("\n")
            : display

        console.log(`${header} ${body}`)
    }

    private writeToFile(dateKey: string, entry: LogEntry): void {
        try {
            if (dateKey !== this.currentLogDate) {
                this.rotateStream(dateKey)
            }

            if (!this.logStream) return

            const line = JSON.stringify(entry) + "\n"
            this.logStream.write(line)
        } catch {
            // Avoid recursive logging if file write fails
        }
    }

    private rotateStream(dateKey: string): void {
        if (this.logStream) {
            this.logStream.end()
            this.logStream = null
        }

        const filePath = path.join(this.logDir, `${dateKey}.log`)
        this.logStream = fs.createWriteStream(filePath, { flags: "a" })
        this.currentLogDate = dateKey

        this.logStream.on("error", (err) => {
            console.error(`[logger] Stream error: ${err.message}`)
        })
    }

    private ensureLogDir(): void {
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true })
        }
    }

    private formatTimestamp(date: Date): string {
        return date.toISOString().replace("T", " ").slice(0, 23)
    }

    private formatDate(date: Date): string {
        return date.toISOString().slice(0, 10) // YYYY-MM-DD
    }

    // ─── Global Error Handlers ─────────────────────────────────────────────────

    private registerGlobalHandlers(): void {
        process.on("uncaughtException", (err: Error) => {
            this.log("process/uncaughtException", err, "error")
            // Give the stream time to flush before exiting
            setTimeout(() => process.exit(1), 200)
        })

        process.on("unhandledRejection", (reason: unknown) => {
            const err =
                reason instanceof Error
                    ? reason
                    : new Error(String(reason ?? "Unhandled rejection"))
            this.log("process/unhandledRejection", err, "error")
        })

        // Graceful shutdown — flush stream
        const shutdown = () => {
            this.log("process", "Shutting down — flushing log stream", "system")
            if (this.logStream) {
                this.logStream.end(() => process.exit(0))
            } else {
                process.exit(0)
            }
        }

        process.once("SIGINT", shutdown)
        process.once("SIGTERM", shutdown)
    }
}

// ─── Singleton export ─────────────────────────────────────────────────────────

export const logger = Logger.getInstance();(globalThis as unknown as { logger: Logger }).logger = logger