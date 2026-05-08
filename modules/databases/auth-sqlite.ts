import { Database } from 'bun:sqlite'
import {
    type AuthenticationState,
    type AuthenticationCreds,
    type SignalDataTypeMap,
    type SignalDataSet,
    initAuthCreds,
    BufferJSON,
} from 'baileys'

export async function useSQLiteAuthState(folder: string): Promise<{
    state: AuthenticationState
    saveCreds: () => Promise<void>
    closeDb: () => void
}> {
    const db = new Database(`${folder}.db`)

    db.exec(`
        CREATE TABLE IF NOT EXISTS auth_sessions (
            key_type TEXT NOT NULL,
            key_id   TEXT NOT NULL,
            value    TEXT NOT NULL,
            PRIMARY KEY (key_type, key_id)
        )
    `)

    const readData = (keyType: string, keyId: string) => {
        const row = db.query(
            `SELECT value FROM auth_sessions
             WHERE key_type = ? AND key_id = ?`
        ).get(keyType, keyId) as { value: string } | undefined

        if (!row) return null
        return JSON.parse(row.value, BufferJSON.reviver)
    }

    const writeData = (keyType: string, keyId: string, value: any) => {
        db.query(
            `INSERT INTO auth_sessions (key_type, key_id, value)
             VALUES (?, ?, ?)
             ON CONFLICT (key_type, key_id)
             DO UPDATE SET value = excluded.value`
        ).run(keyType, keyId, JSON.stringify(value, BufferJSON.replacer))
    }

    const deleteData = (keyType: string, keyId: string) => {
        db.query(
            `DELETE FROM auth_sessions
             WHERE key_type = ? AND key_id = ?`
        ).run(keyType, keyId)
    }

    let creds: AuthenticationCreds = readData('creds', 'default') || initAuthCreds()

    return {
        state: {
            creds,
            keys: {
                get: <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
                    const data: { [id: string]: SignalDataTypeMap[T] } = {}
                    for (const id of ids) {
                        const value = readData(type, id)
                        if (value) data[id] = value
                    }
                    return data
                },
                set: (data: SignalDataSet) => {
                    const upsertMany = db.transaction(() => {
                        for (const [type, ids] of Object.entries(data)) {
                            for (const [id, value] of Object.entries(ids!)) {
                                value !== null && value !== undefined
                                    ? writeData(type, id, value)
                                    : deleteData(type, id)
                            }
                        }
                    })
                    upsertMany()
                },
                clear: () => {
                    db.query(`DELETE FROM auth_sessions`).run()
                }
            }
        },

        saveCreds: async () => {
            writeData('creds', 'default', creds)
        },

        /** Close the SQLite connection — call this before deleting the .db file */
        closeDb: () => {
            db.close()
        }
    }
}