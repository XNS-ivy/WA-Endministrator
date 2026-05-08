import { type WAMessage, type proto, type WAMessageKey, getContentType } from "baileys"
import { config as conf } from "@utils/system-config"


export class MessageParse {
    // protocolMessage is intentionally excluded from this list —
    // it is intercepted upstream in message-processing.ts before fetch() is
    // ever called, so it will never reach here in normal flow.
    private static denied: (keyof proto.IMessage)[] = [
        "senderKeyDistributionMessage",
        "messageContextInfo",
    ]
    private config = conf

    /**
     * Fetches and parses a WhatsApp message into a structured format.
     * 
     * @param msg - The raw WhatsApp message to parse
     * @returns A promise that resolves to a parsed message object with extracted metadata,
     *          or null if the message is invalid or should be ignored
     * 
     * @description
     * This method processes a WAMessage by:
     * - Validating the message has required fields (content and sender name)
     * - Filtering out system messages (status broadcasts)
     * - Extracting message content based on type (text, extended text, media with caption, etc.)
     * - Parsing command syntax if the message starts with the configured prefix
     * - Resolving quoted messages recursively
     * - Determining if the message is from a group chat
     * 
     * @remarks
     * Returns null if:
     * - Message or pushName is missing
     * - Message is from status@broadcast
     * - remoteJid is missing or invalid
     * - Message content cannot be unwrapped
     * - Message type cannot be determined
     * - Converted LID is invalid
     */

    async fetch(msg: WAMessage): Promise<IMessageFetch | null> {

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
        const isOnGroup = remoteJid.endsWith('@g.us') ? true : false
        const prefix = await this.config.get('prefix')
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
            convertedLid
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
    isOnGroup: boolean
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