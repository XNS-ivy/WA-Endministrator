import { makeWASocket, DisconnectReason, Browsers, fetchLatestWaWebVersion } from 'baileys'
import NodeCache from 'node-cache'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import { useSQLiteAuthState } from '@modules/databases/auth-sqlite'
import { ownerDb } from '@modules/databases/owner-sqlite'
import { groupDb } from '@modules/databases/group-sqlite'
import { Boom } from '@hapi/boom'
import { existsSync, unlinkSync } from 'fs'
import { registerMessageProcessing } from '@modules/baileys/message-processing'
import type { ConnectionState } from 'baileys'
import { config } from '@utils/system-config'

class Whatsapp {
    private sock: ReturnType<typeof makeWASocket> | null = null
    private groupCache = new NodeCache({
        stdTTL: 60 * 120,
        deleteOnExpire: true,
        useClones: false,
    })
    private reconnectAttempts = 0
    private readonly MAX_RECONNECT_ATTEMPTS = 5
    private authFileName = 'auth'
    private saveCreds: (() => Promise<void>) | null = null
    private closeDb: (() => void) | null = null

    constructor() { }

    async startWhatsapp(phoneNumber: string | null | undefined) {
        await this.initSocket()
        await this.startEvents()
    }

    private async initSocket() {
        const { state, saveCreds, closeDb } = await useSQLiteAuthState(this.authFileName)
        const pinoLogger = pino({ level: 'silent' })
        this.sock = makeWASocket({
            auth: state,
            markOnlineOnConnect: false,
            cachedGroupMetadata: async (jid) => this.groupCache.get(jid),
            getMessage: async (key) => { return undefined },
            logger: pinoLogger,
            browser: Browsers.appropriate('Google Chrome'),
            version: (await fetchLatestWaWebVersion()).version
        })

        this.saveCreds = saveCreds
        this.closeDb = closeDb
    }

    private async startEvents() {
        if (!this.sock) throw new Error('Socket Not Started Yet')

        this.sock.ev.on('creds.update', this.saveCreds!)

        this.sock.ev.on('connection.update', async (connectionState: Partial<ConnectionState>) => {
            const { connection, lastDisconnect, qr } = connectionState

            if (qr) {
                qrcode.generate(qr, { small: true })
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode

                switch (statusCode) {
                    case DisconnectReason.loggedOut:
                        logger.warn('/modules/baileys/main.ts', 'Logged out. Deleting session...')
                        this.deleteSession()
                        break
                    case DisconnectReason.badSession:
                        logger.warn('/modules/baileys/main.ts', 'Bad session. Deleting session...')
                        this.deleteSession()
                        break
                    case DisconnectReason.restartRequired:
                        logger.info('/modules/baileys/main.ts', 'Restart required. Reconnecting...')
                        await this.startWhatsapp(null)
                        break
                    case 405:
                        logger.warn('/modules/baileys/main.ts', 'WA rejected (405), retrying in 30s...')
                        setTimeout(() => this.startWhatsapp(null), 30_000)
                        break
                    default:
                        await this.handleReconnect()
                }
            } else if (connection === 'open') {
                this.reconnectAttempts = 0
                logger.info('/modules/baileys/main.ts', 'Connected')
            }
        })

        registerMessageProcessing(this.sock, {
            onMessage: async (parsed) => {
                const { commandContent, isOwner, ownerRole, isAdmin, lid, remoteJid } = parsed

                // ── Self-message guard ────────────────────────────────────────
                // Ignore messages sent by the bot itself
                const botLid = this.sock?.user?.lid ?? this.sock?.user?.id
                if (botLid && lid === botLid) return

                // ── Command dispatch ──────────────────────────────────────────
                if (commandContent?.cmd && (config.get('messageLog') === true)) {
                    logger.debug('/modules/baileys/main.ts', {
                        cmd: commandContent.cmd,
                        args: commandContent.args,
                        isOwner,
                        ownerRole,
                        isAdmin,
                        remoteJid,
                    })
                    return
                }
            },

            onRevoke: async ({ remoteJid, deletedMessageId, revokedBy }) => {
                // TODO: anti-delete
                // logger.info('/modules/baileys/main.ts', 'deleted message')
            },

            onEdit: async ({ remoteJid, originalMessageId, newText, editorJid }) => {
                // TODO: anti-edit but its still [object]
                // logger.info('/modules/baileys/main.ts', `edited message`)
            },

            onEphemeralSetting: async ({ remoteJid, ephemeralExpiration }) => {
                // logger.info('//modules/baileys/main.ts', `Disappearing messages: ${ephemeralExpiration}s in ${remoteJid}`)
            },

            onProtocolOther: async ({ type, remoteJid }) => {
                // logger.debug('/modules/baileys/main.ts', { protocolType: type, remoteJid })
            },
        })
    }

    private async handleReconnect() {
        if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
            logger.warn('/modules/baileys/main.ts', 'Max reconnect attempts reached. Stopping.')
            this.cleanup()
            process.exit(1)
        }

        const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 60_000)
        this.reconnectAttempts++
        logger.info('/modules/baileys/main.ts', `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`)
        setTimeout(() => this.startWhatsapp(null), delay)
    }

    private deleteSession() {
        // Close the DB connection first — Bun/Windows locks the file
        // and unlinkSync throws EBUSY if the connection is still open
        this.closeDb?.()
        this.closeDb = null
        ownerDb.close()
        groupDb.close()

        const dbPath = `./${this.authFileName}.db`
        if (existsSync(dbPath)) {
            unlinkSync(dbPath)
            logger.info('/modules/baileys/main.ts', 'Session deleted. Please scan QR again.')
            setTimeout(() => this.startWhatsapp(null), 3000)
        }
    }

    private async cleanup() {
        if (this.sock) {
            this.sock.ev.removeAllListeners('creds.update')
            this.sock.ev.removeAllListeners('connection.update')
            this.sock.ev.removeAllListeners('messages.upsert')
            this.sock.ws.close()
            this.sock = null
        }
        this.closeDb?.()
        this.closeDb = null
        ownerDb.save()
        ownerDb.close()
        groupDb.save()
        groupDb.close()
    }
}

const Hoshino = new Whatsapp()
export default Hoshino