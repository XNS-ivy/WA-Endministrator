import { makeWASocket } from 'baileys'
import NodeCache from 'node-cache'
import pino from 'pino'
import { useSQLiteAuthState } from '@modules/databases/auth-sqlite'

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
        })

        this.saveCreds = saveCreds
        this.sock.ev.on('creds.update', saveCreds)
    }
}

const WAEndmin = new Whatsapp()
export default WAEndmin