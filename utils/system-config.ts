import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SystemConfig {
    name: string
    prefix: string
    messageLog: boolean
}

// ─── Config Loader ────────────────────────────────────────────────────────────

const CONFIG_PATH = resolve('./system-config.json')

class Config {
    private cache: SystemConfig

    constructor() {
        this.cache = this.load()
    }

    // ── Read ──────────────────────────────────────────────────────────────────

    /**
     * Get a single config value by key.
     *
     * ```ts
     * const prefix = config.get('prefix') // "/"
     * ```
     */
    get<K extends keyof SystemConfig>(key: K): SystemConfig[K] {
        return this.cache[key]
    }

    /**
     * Get the entire config object (read-only snapshot).
     */
    getAll(): Readonly<SystemConfig> {
        return { ...this.cache }
    }

    // ── Write ─────────────────────────────────────────────────────────────────

    /**
     * Update a single config value and persist to disk immediately.
     *
     * ```ts
     * config.edit('prefix', '!')
     * config.edit('name', 'Aqua')
     * ```
     */
    edit<K extends keyof SystemConfig>(key: K, value: SystemConfig[K]): void {
        this.cache[key] = value
        this.save()
        logger.system('utils/system-config', `Config updated: ${key} = ${JSON.stringify(value)}`)
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    private load(): SystemConfig {
        try {
            const raw = readFileSync(CONFIG_PATH, 'utf-8')
            return JSON.parse(raw) as SystemConfig
        } catch (err) {
            logger.error('utils/system-config', `Failed to load system-config.json — using defaults`)
            return { name: 'Hoshino', prefix: '/', messageLog: true }
        }
    }

    private save(): void {
        writeFileSync(CONFIG_PATH, JSON.stringify(this.cache, null, 4), 'utf-8')
    }
}

// ─── Singleton export ─────────────────────────────────────────────────────────

export const config = new Config()