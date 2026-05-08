import { makeWASocket, DisconnectReason, Browsers, fetchLatestWaWebVersion } from 'baileys'
import NodeCache from 'node-cache'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import { useSQLiteAuthState } from '@modules/databases/auth-sqlite'
import { Boom } from '@hapi/boom'
import { existsSync, unlinkSync } from 'fs'
import { registerMessageProcessing } from '@modules/baileys/message-processing'
import type { ConnectionState } from 'baileys'

/**
 * WhatsApp client wrapper using Baileys library for WhatsApp Web automation.
 * Handles socket connection, authentication, reconnection logic, and event management.
 * 
 * @class Whatsapp
 * 
 * @property {ReturnType<typeof makeWASocket> | null} sock - The WASocket instance for WhatsApp communication
 * @property {NodeCache} groupCache - Cache for group metadata with 120-minute TTL
 * @property {number} reconnectAttempts - Current number of reconnection attempts
 * @property {number} MAX_RECONNECT_ATTEMPTS - Maximum allowed reconnection attempts (5)
 * @property {string} authFileName - Name of the authentication database file
 * @property {(() => Promise<void>) | null} saveCreds - Function to persist authentication credentials
 * 
 * @method startWhatsapp - Initializes the WhatsApp socket and event listeners
 * @method initSocket - Creates and configures the WASocket instance with authentication state
 * @method startEvents - Registers event handlers for credentials and connection state changes
 * @method handleReconnect - Implements exponential backoff reconnection logic with max attempt limit
 * @method deleteSession - Removes the authentication database file to force re-authentication
 * @method cleanup - Gracefully closes socket connections and removes event listeners
 */

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

    constructor() { }

    async startWhatsapp(phoneNumber: string | null | undefined) {
        await this.initSocket()
        await this.startEvents()
    }

    private async initSocket() {
        const { state, saveCreds } = await useSQLiteAuthState(this.authFileName)
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
                        this.startWhatsapp(null)
                        break
                    case DisconnectReason.badSession:
                        logger.warn('/modules/baileys/main.ts', 'Bad session. Deleting session...')
                        this.deleteSession()
                        this.startWhatsapp(null)
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
                // parsed: IMessageFetch — command sudah di-parse, quoted sudah di-resolve
                // TODO: dispatch ke command handler
                logger.debug('/modules/baileys/main.ts', {parsed})
            },

            onRevoke: async ({ remoteJid, deletedMessageId, revokedBy }) => {
                // TODO: anti-delete — cek groupConfig, forward pesan yang dihapus
            },

            onEdit: async ({ remoteJid, originalMessageId, newText, editorJid }) => {
                // TODO: anti-edit — cek groupConfig, kirim notif pesan yang diedit
            },

            onEphemeralSetting: async ({ remoteJid, ephemeralExpiration }) => {
                logger.info('/modules/baileys/main.ts', `Disappearing messages: ${ephemeralExpiration}s in ${remoteJid}`)
            },

            onProtocolOther: async ({ type, remoteJid }) => {
                // logger.debug('modules/baileys/main', { protocolType: type, remoteJid })
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
        const dbPath = `./${this.authFileName}.db`
        if (existsSync(dbPath)) {
            unlinkSync(dbPath)
            logger.info('/modules/baileys/main.ts', 'Session deleted. Please scan QR again.')
        }
    }

    private cleanup() {
        if (this.sock) {
            this.sock.ev.removeAllListeners('creds.update')
            this.sock.ev.removeAllListeners('connection.update')
            this.sock.ev.removeAllListeners('messages.upsert')
            this.sock.ws.close()
            this.sock = null
        }
    }
}

const Hoshino = new Whatsapp()
export default Hoshino