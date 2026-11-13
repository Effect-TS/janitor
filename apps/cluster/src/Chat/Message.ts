import * as DiscordChat from "@effect/chat-discord/DiscordChat"
import * as SlackChat from "@effect/chat-slack/SlackChat"
import type * as ChatMessages from "effect/chat/ChatMessage"
import type * as ChatThreads from "effect/chat/ChatThread"
import type { ChatAttachment, ChatMessage, ChatThread } from "@janitor/domain/Chat/Session"

/**
 * Where `effect/chat` meets what sessions store (EFF-3018, EFF-3791).
 *
 * A session runs on `effect/chat`'s `ChatThread`. The domain `ChatThread`
 * is only its stored form: the `Receive` payload, the session row, the
 * sessions page and the session key, all of which predate `effect/chat` and
 * name the Discord guild, which an `effect/chat` address doesn't. `address`
 * is the one way from the stored form, at `Receive` and on a restart.
 *
 * The domain `ChatMessage` is a transcript entry, not a platform message:
 * what admission and the bot-mention rules made of one, as the gate, the
 * model and the sessions page read it. `sessionMessage` makes one from an
 * `effect/chat` message, once, where the message is read.
 */

/** The session key, and the session entity's id: `slack/{team}/{channel}/{thread_ts}` or `discord/{guild}/{thread_id}`. */
export const sessionKey = (thread: ChatThread): string =>
  thread._tag === "Slack"
    ? `slack/${thread.team}/${thread.channel}/${thread.threadTs}`
    : `discord/${thread.guild}/${thread.threadId}`

/** A stored thread as the `effect/chat` address the session runs on. */
export const address = (thread: ChatThread): ChatThreads.ChatThread =>
  thread._tag === "Slack"
    ? SlackChat.thread({ team: thread.team, channel: thread.channel, threadTs: thread.threadTs })
    : DiscordChat.thread(thread.threadId)

/**
 * What an admitted user's 👍 on one of the bot's messages hands the session
 * (EFF-3163): a message that counts as a mention, so a yes/no question or a
 * request for approval can be answered with a reaction.
 */
export const APPROVAL_TEXT = "👍 (reacted with a thumbs up to your message: approved)"

/** An approval's message id, unlike any platform message id, so sessions store each once. */
export const approvalMessageId = (messageId: string, userId: string): string =>
  `reaction/${messageId}/${userId}`

/**
 * An `effect/chat` message as its session keeps it: `author` as admission
 * classified them, and the text without the mentions `isBot` picks, cut by
 * their offsets so only mentions the platform resolved outside code go. It
 * mentions the bot when it has such a mention, or answers `botUserId`: a
 * reply to one of the bot's messages is addressed to the bot whether or not
 * it pings (EFF-3137).
 *
 * A Discord attachment's id is prefixed with its message's channel, which
 * the download reads it from: a thread's opener is in the parent channel.
 */
export const sessionMessage = (
  message: ChatMessages.ChatMessage,
  author: ChatMessage["author"],
  options: {
    readonly isBot?: ((mention: ChatMessages.Mention) => boolean) | undefined
    readonly botUserId?: string | undefined
  } = {},
): ChatMessage => {
  const isBot = options.isBot ?? ((mention: ChatMessages.Mention) => mention.isSelf)
  const answers = message.replyTo?.authorId
  let text = message.text
  const cut = message.mentions.filter(isBot).sort((a, b) => b.start - a.start)
  for (const mention of cut) text = text.slice(0, mention.start) + text.slice(mention.end)
  return {
    id: message.id,
    author,
    text: text.trim(),
    mentionsBot: cut.length > 0 || (answers !== undefined && answers === options.botUserId),
    sentAt: message.timestamp,
    attachments: message.attachments.map((attachment) => ({
      id:
        message.thread.platform === "discord"
          ? `${message.thread.id}/${attachment.id}`
          : attachment.id,
      name: attachment.name ?? attachment.id,
      mediaType: attachment.contentType ?? "application/octet-stream",
      size: Math.max(0, Math.floor(attachment.size ?? 0)),
    })),
    ...(answers === undefined ? {} : { answers }),
  }
}

/**
 * Where a session's attachment is downloaded from, as `effect/chat` names
 * it: a Discord attachment from its message's channel, `{channel}/{message}/{attachment}`.
 */
export const attachmentSource = (
  thread: ChatThreads.ChatThread,
  attachment: ChatAttachment,
): { readonly thread: ChatThreads.ChatThread; readonly attachment: ChatMessages.Attachment } => {
  const [channel, ...id] = attachment.id.split("/")
  return thread.platform === "discord" && channel !== undefined && id.length === 2
    ? {
        thread: DiscordChat.thread(channel),
        attachment: { id: id.join("/"), size: attachment.size },
      }
    : { thread, attachment: { id: attachment.id, size: attachment.size } }
}
