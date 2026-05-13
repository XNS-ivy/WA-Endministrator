import { Database } from 'bun:sqlite'
import { resolve } from 'path'

// ─── Types ────────────────────────────────────────────────────────────────────

export type OwnerRole = 'master' | 'owner'

export interface IOwnerEntry {
    lid: string
    role: OwnerRole
    addedAt: number
}

// ─── DB singleton ─────────────────────────────────────────────────────────────

const DB_PATH = resolve('./owner.db')

class OwnerDatabase {
    private db: Database

    constructor() {
        this.db = new Database(DB_PATH)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS owners (
                lid     TEXT PRIMARY KEY,
                role    TEXT NOT NULL CHECK(role IN ('master', 'owner')),
                addedAt INTEGER NOT NULL
            )
        `)
        logger.system('/modules/databases/owner-sqlite.ts', 'Owner DB ready')
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    getAll(): IOwnerEntry[] {
        return this.db
            .query(`SELECT lid, role, addedAt FROM owners`)
            .all() as IOwnerEntry[]
    }

    get(lid: string): IOwnerEntry | null {
        return (this.db
            .query(`SELECT lid, role, addedAt FROM owners WHERE lid = ?`)
            .get(lid) as IOwnerEntry | undefined) ?? null
    }

    /**
     * Returns the role of the given lid, or null if not an owner.
     * Accepts both raw lids and LID-converted strings (numbers only).
     */
    getRole(lid: string): OwnerRole | null {
        return this.get(lid)?.role ?? null
    }

    isMaster(lid: string): boolean {
        return this.get(lid)?.role === 'master'
    }

    isOwner(lid: string): boolean {
        const role = this.get(lid)?.role
        return role === 'master' || role === 'owner'
    }

    // ── Mutations ─────────────────────────────────────────────────────────────

    add(lid: string, role: OwnerRole = 'owner'): void {
        this.db
            .query(
                `INSERT INTO owners (lid, role, addedAt)
                 VALUES (?, ?, ?)
                 ON CONFLICT(lid) DO UPDATE SET role = excluded.role`
            )
            .run(lid, role, Date.now())
        logger.system('/modules/databases/owner-sqlite.ts', `Owner added/updated: ${lid} (${role})`)
    }

    remove(lid: string): boolean {
        const changes = (this.db
            .query(`DELETE FROM owners WHERE lid = ?`)
            .run(lid) as { changes: number }).changes
        if (changes > 0) {
            logger.system('/modules/databases/owner-sqlite.ts', `Owner removed: ${lid}`)
        }
        return changes > 0
    }

    /**
     * Seed a master owner on first run if the table is empty.
     * Safe to call on every startup — no-ops when a master already exists.
     */
    seedMaster(lid: string): void {
        const existing = this.db
            .query(`SELECT COUNT(*) as count FROM owners WHERE role = 'master'`)
            .get() as { count: number }
        if (existing.count === 0) {
            this.add(lid, 'master')
            logger.system('/modules/databases/owner-sqlite.ts', `Master seeded: ${lid}`)
        }
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    save(): void {
        logger.system('/modules/databases/owner-sqlite.ts', 'Owner DB saved')
    }

    close(): void {
        this.db.close()
        logger.system('/modules/databases/owner-sqlite.ts', 'Owner DB closed')
    }
}

// ─── Singleton export ─────────────────────────────────────────────────────────

export const ownerDb = new OwnerDatabase()
