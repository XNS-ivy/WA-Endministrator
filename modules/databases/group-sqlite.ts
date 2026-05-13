import { Database } from 'bun:sqlite'
import { resolve } from 'path'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IGroupEntry {
    groupID: string
    label: string | null
    addedAt: number
    addedBy: string
}

// ─── DB singleton ─────────────────────────────────────────────────────────────

const DB_PATH = resolve('./group.db')

class GroupDatabase {
    private db: Database

    constructor() {
        this.db = new Database(DB_PATH)
        this.db.run(`
            CREATE TABLE IF NOT EXISTS allowed_groups (
                groupID     TEXT PRIMARY KEY,
                label   TEXT,
                addedAt INTEGER NOT NULL,
                addedBy TEXT    NOT NULL
            )
        `)
        logger.system('/modules/databases/group-sqlite.ts', 'Group DB ready')
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    getAll(): IGroupEntry[] {
        return this.db
            .query(`SELECT groupID, label, addedAt, addedBy FROM allowed_groups`)
            .all() as IGroupEntry[]
    }

    get(groupID: string): IGroupEntry | null {
        return (this.db
            .query(`SELECT groupID, label, addedAt, addedBy FROM allowed_groups WHERE groupID = ?`)
            .get(groupID) as IGroupEntry | undefined) ?? null
    }

    /**
     * Returns true if the groupID is registered as an allowed group.
     * DM chats (non @g.us) always return false — they are not groups.
     */
    isAllowed(groupID: string): boolean {
        if (!groupID.endsWith('@g.us')) return false
        return this.get(groupID) !== null
    }

    // ── Mutations ─────────────────────────────────────────────────────────────

    /**
     * Register a group as allowed.
     * @param groupID     - GroupID (must end with @g.us)
     * @param addedBy - Owner groupID / convertedLid who authorized this group
     * @param label   - Optional human-readable name for reference
     */
    allow(groupID: string, addedBy: string, label?: string): void {
        if (!groupID.endsWith('@g.us')) {
            logger.warn('/modules/databases/group-sqlite.ts', `allow() called with non-group groupID: ${groupID}`)
            return
        }
        this.db
            .query(
                `INSERT INTO allowed_groups (groupID, label, addedAt, addedBy)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(groupID) DO UPDATE SET
                     label   = excluded.label,
                     addedBy = excluded.addedBy`
            )
            .run(groupID, label ?? null, Date.now(), addedBy)
        logger.system('/modules/databases/group-sqlite.ts', `Group allowed: ${groupID} by ${addedBy}`)
    }

    /**
     * Revoke a group's access. Returns true if the group was actually removed.
     */
    revoke(groupID: string): boolean {
        const changes = (this.db
            .query(`DELETE FROM allowed_groups WHERE groupID = ?`)
            .run(groupID) as { changes: number }).changes
        if (changes > 0) {
            logger.system('/modules/databases/group-sqlite.ts', `Group revoked: ${groupID}`)
        }
        return changes > 0
    }

    /**
     * Update the label of an already-registered group.
     */
    setLabel(groupID: string, label: string): void {
        this.db
            .query(`UPDATE allowed_groups SET label = ? WHERE groupID = ?`)
            .run(label, groupID)
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    save(): void {
        logger.system('/modules/databases/group-sqlite.ts', 'Group DB saved')
    }

    close(): void {
        this.db.close()
        logger.system('/modules/databases/group-sqlite.ts', 'Group DB closed')
    }
}

// ─── Singleton export ─────────────────────────────────────────────────────────

export const groupDb = new GroupDatabase()
