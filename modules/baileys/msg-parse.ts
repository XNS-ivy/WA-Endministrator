import { type WAMessage, type proto, type WAMessageKey, getContentType, type WASocket } from "baileys"
import { config } from "@utils/system-config"
import { ownerDb, type OwnerRole } from "@modules/databases/owner-sqlite"
import { groupDb } from "@modules/databases/group-sqlite"


export class MessageParse {
    // protocolMessage is intentionally excluded — intercepted upstream in
    // message-processing.ts before fetch() is ever called.
    //
    // secretEncryptedMessage is excluded because its payload is encrypted
    // and cannot be decoded here; MESSAGE_EDIT variants are routed to
    // onEdit (with newText: null) in message-processing.ts instead.
    private static denied: (keyof proto.IMessage)[] = [
        "senderKeyDistributionMessage",
        "messageContextInfo",
        "secretEncryptedMessage",
    ]
    
    /**
     * Fetches and parses a WhatsApp message, extracting relevant content and metadata.
     * 
     * @param msg - The WhatsApp message to parse
     * @returns A promise that resolves to an IMessageFetch object containing parsed message data,
     *          or null if the message is invalid or should be skipped
     * 
     * @remarks
     * - Filters out denied message types
     * - Extracts text, caption, and description based on message type
     * - Parses command content if message starts with configured prefix
     * - Handles quoted messages recursively
     * - Detects group messages vs direct messages
     * 
     * @example
     * ```typescript
     * const parsedMsg = await msgParser.fetch(waMessage);
     * if (parsedMsg?.commandContent) {
     *   console.log(`Command: ${parsedMsg.commandContent.cmd}`);
     * }
     * ```
     */
    async fetch(msg: WAMessage, sock: WASocket): Promise<IMessageFetch | null> {

        const { key, pushName, message } = msg
        const rawMessage = unwrapMessage(message as proto.IMessage)
        const { remoteJid } = key
        const lid = this.getLID(key)
        const messageTimestamp = Date.now()

        if (!message || !pushName) return null
        if (remoteJid === "status@broadcast" || !remoteJid) return null
        if (!rawMessage) return null

        const m = message as proto.IMessage
        const res: Partial<Record<keyof proto.IMessage, any>> = {}

        for (const k of Object.keys(m) as (keyof proto.IMessage)[]) {
            if (!MessageParse.denied.includes(k)) {
                res[k] = m[k]
            }
        }

        const messageObject = getContentType(rawMessage) as keyof proto.IMessage
        if (!messageObject) return null
        const content = res[messageObject]
        if (!content) return null

        let textMsg: string | null = null
        let caption: string | null = null
        let description: string | null = null
        let contextInfo: proto.IContextInfo | undefined
        let expiration = 0

        if (messageObject === 'conversation') {
            textMsg = content as string
        }
        else if (messageObject === 'extendedTextMessage') {
            const c = content as proto.Message.IExtendedTextMessage
            textMsg = c.text ?? null
            description = c.description ?? null
            contextInfo = c.contextInfo ?? undefined
            expiration = (c as any).expiration ?? 0
        }
        else {
            const c = content as {
                caption?: string
                contextInfo?: proto.IContextInfo
                expiration?: number
            }
            caption = c?.caption ?? null
            contextInfo = c?.contextInfo ?? undefined
            expiration = c?.expiration ?? 0
        }

        const quotedMessage = contextInfo?.quotedMessage
        const mentionedJid = contextInfo?.mentionedJid ?? []
        const chatExpiration = expiration > 0 ? expiration : 0
        const quoted = quotedMessage
            ? await this.quotedMessageFetch(quotedMessage)
            : null
        const isOnGroup = remoteJid.endsWith('@g.us') ? (await sock.groupMetadata(remoteJid)).id : false
        const prefix = config.get('prefix')
        const body: string = textMsg ?? caption ?? ""
        let commandContent: null | { cmd: string; args: string[] } = null
        if (body?.startsWith(prefix)) {
            const parts = body
                .slice(prefix.length)
                .trim()
                .split(/\s+/)
            const cmd = parts.shift() ?? ""
            const args = parts
            commandContent = {
                cmd,
                args
            }
        }
        const convertedLid = convertLID(lid)
        if (!lid) return null

        // ── Owner check ───────────────────────────────────────────────────────
        // Try convertedLid first (numeric-only), then full JID as fallback
        const senderJid = key.participant ?? remoteJid
        const ownerLookup = convertedLid ?? senderJid
        const ownerRole: OwnerRole | null = ownerDb.getRole(ownerLookup)
        const isOwner: boolean = ownerRole !== null

        // ── Group admin check ─────────────────────────────────────────────────
        // Only meaningful in groups; always false in DMs
        let isAdmin = false
        if (isOnGroup) {
            try {
                const meta = await sock.groupMetadata(remoteJid)
                const participant = meta.participants.find(
                    p => p.id === senderJid || p.id === key.participant
                )
                isAdmin = participant?.admin === 'admin' || participant?.admin === 'superadmin'
            } catch {
                // groupMetadata can fail if bot was just added — safe to skip
                isAdmin = false
            }
        }

        // ── Group allowlist check ─────────────────────────────────────────────
        // DMs are always allowed (isOnGroup is false → true).
        // Group messages are allowed only if the group JID is registered in the
        // allowlist via groupDb.  Callers should gate command execution behind
        // this flag so the bot cannot be used in unregistered groups.
        const isGroupAllowed: boolean = isOnGroup
            ? groupDb.isAllowed(remoteJid)
            : true

        return {
            remoteJid,
            lid,
            key,
            pushName,
            isOnGroup,
            messageTimestamp,
            type: messageObject,
            text: textMsg,
            caption,
            description,
            expiration: chatExpiration,
            mentionedJid,
            quoted,
            raw: msg,
            rawQuoted: quotedMessage ?? null,
            commandContent,
            convertedLid,
            isOwner,
            ownerRole,
            isAdmin,
            isGroupAllowed,
        }
    }

    private async quotedMessageFetch(qMsg: proto.IMessage): Promise<IQuotedMessage | null> {
        if (!qMsg) return null
        const extracted = this.extractQuoted(qMsg)
        if (!extracted) return null

        const quotedType = getContentType(extracted) as keyof proto.IMessage
        const quotedContent: any = extracted[quotedType]

        const text = quotedType === 'conversation'
            ? (typeof quotedContent === 'string' ? quotedContent : null)
            : quotedContent?.text ?? null

        return {
            type: quotedType,
            text,
            caption: quotedContent?.caption ?? null,
            description: quotedContent?.description ?? null,
            expiration: quotedContent?.expiration ?? 0,
            mentionedJid: quotedContent?.contextInfo?.mentionedJid ?? [],
            rawQuoted: extracted,
        }
    }

    private extractQuoted(quotedMessage: proto.IMessage | undefined): proto.IMessage | null {
        if (!quotedMessage) return null

        const msg = quotedMessage as proto.IMessage | undefined
        if (!msg) return null

        const keys = Object.keys(msg) as (keyof proto.IMessage)[]
        const main = keys.find(k => !MessageParse.denied.includes(k))
        if (!main) return null

        return {
            [main]: msg[main]
        }
    }

    /**
     * Extracts the LID (Local ID) from a WAMessageKey object.
     * Searches for a LID in the remoteJid first, then falls back to the participant field.
     * A LID is identified by an address ending with '@lid'.
     * 
     * @param key - The WAMessageKey object to extract the LID from
     * @returns The LID string if found, otherwise null
     */
    getLID(key: WAMessageKey): string | null {
        const lid = key?.remoteJid?.endsWith('@lid')
            ? key.remoteJid
            : key?.participant?.endsWith('@lid')
                ? key.participant
                : null
        return lid
    }
}

export interface IMessageParse {
    fetch(message: WAMessage): Promise<IMessageFetch | null>
}

interface IKeyFetch {
    remoteJid: string,
    lid: string,
    key: WAMessageKey,
}

export interface IMessageFetch extends IKeyFetch {
    pushName: string | null | undefined,
    isOnGroup: string | false
    messageTimestamp: number,
    type: keyof proto.IMessage,
    messageObject?: string,
    text: string | null | undefined,
    caption: string | null | undefined,
    description: string | null | undefined,
    expiration: number,
    mentionedJid: Array<string> | [],
    quoted: IQuotedMessage | null,
    raw: WAMessage,
    rawQuoted?: proto.IMessage | null,
    commandContent: null | {
        cmd: string,
        args: Array<string>,
    }
    convertedLid: string | null,
    /** True if sender is registered in the owner database (any role) */
    isOwner: boolean,
    /** 'master' | 'owner' | null — null means not an owner */
    ownerRole: OwnerRole | null,
    /** True if sender is group admin or superadmin (always false in DMs) */
    isAdmin: boolean,
    /**
     * True when the message is from a DM, or from a group that has been
     * registered in the allowlist by an owner (groupDb.allow()).
     * False means the group is not registered — commands should be blocked.
     */
    isGroupAllowed: boolean,
    // add more type here if needed
}

interface IQuotedMessage {
    type: keyof proto.IMessage,
    text: string | null,
    caption: string | null,
    description: string | null,
    expiration: number,
    mentionedJid: Array<string | null>,
    rawQuoted: proto.IMessage,
}

export const message = new MessageParse()

type MessageContent<T extends keyof proto.IMessage> = proto.IMessage[T]


function unwrapMessage(msg: proto.IMessage | undefined | null): proto.IMessage | null {
    if (!msg) return null

    if (msg.ephemeralMessage?.message)
        return unwrapMessage(msg.ephemeralMessage.message)

    if (msg.viewOnceMessage?.message)
        return unwrapMessage(msg.viewOnceMessage.message)

    if (msg.viewOnceMessageV2?.message)
        return unwrapMessage(msg.viewOnceMessageV2.message)

    return msg
}

export function convertLID(lid: string | null): string | null {
    if (!lid) return null
    const result = (lid
        .replace(/@lid$/i, '')
        .replace(/^@/, '')
        .split(':')[0]
        ?.trim()) || null
    return result || null
}