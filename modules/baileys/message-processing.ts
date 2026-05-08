import type { WASocket, WAMessage } from 'baileys'
import { proto } from 'baileys'
import { message as msgParser } from './msg-parse'
import type { IMessageFetch } from './msg-parse'

// ─── Shorthand ────────────────────────────────────────────────────────────────

const PMType = proto.Message.ProtocolMessage.Type

// ─── Per-type payload interfaces ──────────────────────────────────────────────

export interface IOnRevokePayload {
    remoteJid: string
    /** ID of the message that was deleted */
    deletedMessageId: string
    /** In groups: participant JID; in DMs: remoteJid */
    revokedBy: string
}

export interface IOnEditPayload {
    remoteJid: string
    /** ID of the original message that was replaced */
    originalMessageId: string
    /** New text after the edit — null for non-text messages */
    newText: string | null
    editorJid: string
}

export interface IOnEphemeralSettingPayload {
    remoteJid: string
    /** 0 = disabled, otherwise seconds until disappear */
    ephemeralExpiration: number
    /** Unix timestamp (seconds) when this setting was applied */
    ephemeralSettingTimestamp: number
}

export interface IOnHistorySyncPayload {
    remoteJid: string
    raw: proto.Message.IHistorySyncNotification
}

export interface IOnAppStateSyncKeySharePayload {
    remoteJid: string
    raw: proto.Message.IAppStateSyncKeyShare
}

export interface IOnAppStateSyncKeyRequestPayload {
    remoteJid: string
    raw: proto.Message.IAppStateSyncKeyRequest
}

export interface IOnAppStateFatalExceptionPayload {
    remoteJid: string
    raw: proto.Message.IAppStateFatalExceptionNotification
}

export interface IOnSharePhoneNumberPayload {
    remoteJid: string
    /** JID of whoever shared their phone number */
    senderJid: string
}

export interface IOnPeerDataOperationRequestPayload {
    remoteJid: string
    raw: proto.Message.IPeerDataOperationRequestMessage
}

export interface IOnPeerDataOperationResponsePayload {
    remoteJid: string
    raw: proto.Message.IPeerDataOperationRequestResponseMessage
}

/**
 * Catch-all for types that carry no meaningful structured data:
 * EPHEMERAL_SYNC_RESPONSE, MSG_FANOUT_BACKFILL_REQUEST,
 * INITIAL_SECURITY_NOTIFICATION_SETTING_SYNC, REQUEST_WELCOME_MESSAGE,
 * BOT_FEEDBACK_MESSAGE, MEDIA_NOTIFY_MESSAGE,
 * CLOUD_API_THREAD_CONTROL_NOTIFICATION, LID_MIGRATION_MAPPING_SYNC,
 * REMINDER_MESSAGE, BOT_MEMU_ONBOARDING_MESSAGE, STATUS_MENTION_MESSAGE,
 * STOP_GENERATION_MESSAGE, LIMIT_SHARING, AI_PSI_METADATA,
 * AI_QUERY_FANOUT, GROUP_MEMBER_LABEL_CHANGE
 */
export interface IOnProtocolOtherPayload {
    type: proto.Message.ProtocolMessage.Type
    remoteJid: string
    raw: proto.Message.IProtocolMessage
}

// ─── Callback map ─────────────────────────────────────────────────────────────

export interface IMessageProcessingCallbacks {
    // ── Regular messages ─────────────────────────────────────────────────────

    /**
     * Every successfully parsed regular message.
     * Delegates to MessageParse.fetch() — full pipeline:
     * unwrap ephemeral/viewOnce, extract text/caption, resolve quoted,
     * parse command, convert LID.
     */
    onMessage?: (parsed: IMessageFetch) => Promise<void>

    // ── Typed protocol callbacks ──────────────────────────────────────────────

    /** A message was deleted/revoked */
    onRevoke?: (payload: IOnRevokePayload) => Promise<void>

    /** A message was edited */
    onEdit?: (payload: IOnEditPayload) => Promise<void>

    /** Disappearing messages setting changed in a chat */
    onEphemeralSetting?: (payload: IOnEphemeralSettingPayload) => Promise<void>

    /** History sync notification (received on first connect) */
    onHistorySync?: (payload: IOnHistorySyncPayload) => Promise<void>

    /** App state sync key share */
    onAppStateSyncKeyShare?: (payload: IOnAppStateSyncKeySharePayload) => Promise<void>

    /** App state sync key request */
    onAppStateSyncKeyRequest?: (payload: IOnAppStateSyncKeyRequestPayload) => Promise<void>

    /** App state fatal exception notification */
    onAppStateFatalException?: (payload: IOnAppStateFatalExceptionPayload) => Promise<void>

    /** Someone shared their phone number */
    onSharePhoneNumber?: (payload: IOnSharePhoneNumberPayload) => Promise<void>

    /** Peer data operation request */
    onPeerDataOperationRequest?: (payload: IOnPeerDataOperationRequestPayload) => Promise<void>

    /** Peer data operation response */
    onPeerDataOperationResponse?: (payload: IOnPeerDataOperationResponsePayload) => Promise<void>

    /** Catch-all for remaining protocol types (see IOnProtocolOtherPayload) */
    onProtocolOther?: (payload: IOnProtocolOtherPayload) => Promise<void>
}

// ─── Register function ────────────────────────────────────────────────────────

/**
 * Attaches `messages.upsert` to the given socket and fans out each incoming
 * message to the matching callback.
 *
 * Only register the callbacks you actually need — unregistered ones are
 * silently skipped with zero overhead.
 *
 * Usage inside `startEvents()` in `main.ts`:
 * ```ts
 * import { registerMessageProcessing } from '@modules/baileys/message-processing'
 *
 * registerMessageProcessing(this.sock, {
 *     onMessage: async (parsed) => {
 *         if (!parsed.commandContent) return
 *         // dispatch to command handler...
 *     },
 *     onRevoke: async ({ remoteJid, deletedMessageId, revokedBy }) => {
 *         // anti-delete logic here
 *     },
 *     onEdit: async ({ remoteJid, originalMessageId, newText }) => {
 *         // anti-edit logic here
 *     },
 * })
 * ```
 */
export function registerMessageProcessing(
    sock: WASocket,
    callbacks: IMessageProcessingCallbacks = {}
): void {
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        // 'append' = history sync on first connect — not real-time, skip
        if (type !== 'notify') return

        for (const msg of messages) {
            try {
                await processOne(msg, callbacks)
            } catch (err) {
                logger.error(
                    '/modules/baileys/message-processing.ts',
                    err instanceof Error ? err : new Error(String(err))
                )
            }
        }
    })

    logger.system('/modules/baileys/message-processing.ts', 'messages.upsert listener registered')
}

// ─── Internal ─────────────────────────────────────────────────────────────────

async function processOne(
    msg: WAMessage,
    callbacks: IMessageProcessingCallbacks
): Promise<void> {
    const { message, key } = msg
    if (!message || !key.remoteJid) return

    const protocol = message.protocolMessage
    if (protocol) {
        await routeProtocol(key, protocol, callbacks)
        return
    }

    if (!callbacks.onMessage) return

    const parsed = await msgParser.fetch(msg)
    if (parsed) await callbacks.onMessage(parsed)
}

async function routeProtocol(
    key: WAMessage['key'],
    protocol: proto.Message.IProtocolMessage,
    cb: IMessageProcessingCallbacks
): Promise<void> {
    const pmType = protocol.type
    if (pmType == null) return
    const remoteJid = key.remoteJid!
    const senderJid = key.participant ?? remoteJid

    switch (pmType) {

        case PMType.REVOKE: {
            if (!cb.onRevoke) return
            const deletedId = protocol.key?.id
            if (!deletedId) return
            await cb.onRevoke({
                remoteJid,
                deletedMessageId: deletedId,
                revokedBy: senderJid,
            })
            break
        }

        case PMType.MESSAGE_EDIT: {
            if (!cb.onEdit) return
            if (!key.id) return
            const edited = protocol.editedMessage
            const newText =
                edited?.conversation ??
                edited?.extendedTextMessage?.text ??
                null
            await cb.onEdit({
                remoteJid,
                originalMessageId: key.id,
                newText,
                editorJid: senderJid,
            })
            break
        }

        case PMType.EPHEMERAL_SETTING: {
            if (!cb.onEphemeralSetting) return
            await cb.onEphemeralSetting({
                remoteJid,
                ephemeralExpiration: protocol.ephemeralExpiration ?? 0,
                ephemeralSettingTimestamp: Number(protocol.ephemeralSettingTimestamp ?? 0),
            })
            break
        }

        case PMType.HISTORY_SYNC_NOTIFICATION: {
            if (!cb.onHistorySync || !protocol.historySyncNotification) return
            await cb.onHistorySync({ remoteJid, raw: protocol.historySyncNotification })
            break
        }

        case PMType.APP_STATE_SYNC_KEY_SHARE: {
            if (!cb.onAppStateSyncKeyShare || !protocol.appStateSyncKeyShare) return
            await cb.onAppStateSyncKeyShare({ remoteJid, raw: protocol.appStateSyncKeyShare })
            break
        }

        case PMType.APP_STATE_SYNC_KEY_REQUEST: {
            if (!cb.onAppStateSyncKeyRequest || !protocol.appStateSyncKeyRequest) return
            await cb.onAppStateSyncKeyRequest({ remoteJid, raw: protocol.appStateSyncKeyRequest })
            break
        }

        case PMType.APP_STATE_FATAL_EXCEPTION_NOTIFICATION: {
            if (!cb.onAppStateFatalException || !protocol.appStateFatalExceptionNotification) return
            await cb.onAppStateFatalException({
                remoteJid,
                raw: protocol.appStateFatalExceptionNotification,
            })
            break
        }

        case PMType.SHARE_PHONE_NUMBER: {
            if (!cb.onSharePhoneNumber) return
            await cb.onSharePhoneNumber({ remoteJid, senderJid })
            break
        }

        case PMType.PEER_DATA_OPERATION_REQUEST_MESSAGE: {
            if (!cb.onPeerDataOperationRequest || !protocol.peerDataOperationRequestMessage) return
            await cb.onPeerDataOperationRequest({
                remoteJid,
                raw: protocol.peerDataOperationRequestMessage,
            })
            break
        }

        case PMType.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE: {
            if (!cb.onPeerDataOperationResponse || !protocol.peerDataOperationRequestResponseMessage) return
            await cb.onPeerDataOperationResponse({
                remoteJid,
                raw: protocol.peerDataOperationRequestResponseMessage,
            })
            break
        }

        // EPHEMERAL_SYNC_RESPONSE, MSG_FANOUT_BACKFILL_REQUEST,
        // INITIAL_SECURITY_NOTIFICATION_SETTING_SYNC, REQUEST_WELCOME_MESSAGE,
        // BOT_FEEDBACK_MESSAGE, MEDIA_NOTIFY_MESSAGE,
        // CLOUD_API_THREAD_CONTROL_NOTIFICATION, LID_MIGRATION_MAPPING_SYNC,
        // REMINDER_MESSAGE, BOT_MEMU_ONBOARDING_MESSAGE, STATUS_MENTION_MESSAGE,
        // STOP_GENERATION_MESSAGE, LIMIT_SHARING, AI_PSI_METADATA,
        // AI_QUERY_FANOUT, GROUP_MEMBER_LABEL_CHANGE
        default: {
            if (!cb.onProtocolOther) return
            await cb.onProtocolOther({ type: pmType, remoteJid, raw: protocol })
        }
    }
}