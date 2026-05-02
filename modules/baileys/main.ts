import { makeWASocket, DisconnectReason, Browsers, fetchLatestWaWebVersion } from 'baileys'
import NodeCache from 'node-cache'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import { useSQLiteAuthState } from '@modules/databases/auth-sqlite'
import { Boom } from '@hapi/boom'

import type { ConnectionState } from 'baileys'

class Whatsapp {
    private sock: ReturnType<typeof makeWASocket> | null = null
    private groupCache = new NodeCache({
        stdTTL: 60 * 120,
        deleteOnExpire: true,
        useClones: false,
    })
    private saveCreds: (() => Promise<void>) | null = null

    constructor() { }

    async startWhatsapp() {
        await this.initSocket()
        await this.startEvents()
    }

    private async initSocket() {
        const { state, saveCreds } = await useSQLiteAuthState('auth')
        const logger = pino({ level: 'silent' })
        this.sock = makeWASocket({
            auth: state,
            markOnlineOnConnect: false,
            cachedGroupMetadata: async (jid) => this.groupCache.get(jid),
            getMessage: async (key) => { return undefined },
            logger,
            browser: Browsers.appropriate('Google Chrome'),
            version: (await fetchLatestWaWebVersion()).version
        })

        this.saveCreds = saveCreds
    }

    private async startEvents() {
        if (!this.sock) throw new Error('Socket Not Started Yet')
        this.sock.ev.on('creds.update', this.saveCreds!)
        this.sock.ev.on('connection.update', async (connectionState: Partial<ConnectionState>) => {
            const { connection, lastDisconnect, qr, isNewLogin, isOnline } = connectionState

            if (qr) {
                qrcode.generate(qr, { small: true })
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut

                console.log('Connection closed, status:', statusCode, '| reconnect:', shouldReconnect)
                if (shouldReconnect && statusCode !== 405) {
                    await this.startWhatsapp()
                } else if (statusCode === 405) {
                    console.log('WhatsApp Rejected (405), wait a few minutes before reconnecting...')
                    setTimeout(() => this.startWhatsapp(), 30_000)
                }

            } else if (connection === 'open') {
                console.log('Koneksi berhasil!')
            }
        })
    }
}

const WAEndmin = new Whatsapp()
export default WAEndmin