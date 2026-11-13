import type * as ChatMessages from "effect/chat/ChatMessage"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as SlackChat from "@effect/chat-slack/SlackChat"
import type { AuthorClass, ChatMessage, ChatThread } from "../Platform.ts"
import { withoutMentions } from "../Platform.ts"

/**
 * What Slack ingress and Slack's `ChatPlatform` share (EFF-3019): the
 * address of a session's thread, the admission rule and how an
 * `effect/chat` message becomes a session's `ChatMessage`.
 */

/** A session's Slack thread as an `effect/chat` address. */
export const address = (thread: Extract<ChatThread, { readonly _tag: "Slack" }>) =>
  SlackChat.thread({ team: thread.team, channel: thread.channel, threadTs: thread.threadTs })

export interface SlackAuthor {
  readonly class: AuthorClass
  readonly name: string
}

/**
 * Admits a Slack user with `users.info`: a full member of our workspace (its
 * `team_id`), not a guest, a stranger or deleted. Any bot account is a bot.
 * A failed lookup denies: the author is an outsider.
 */
export const lookUpAuthor = (
  slack: SlackChat.SlackChat["Service"],
  workspaceId: string,
  userId: string,
): Effect.Effect<SlackAuthor> =>
  slack.user(userId).pipe(
    Effect.map((user): SlackAuthor => {
      if (user.isBot) return { class: "bot", name: user.name }
      const admitted =
        user.teamId === workspaceId &&
        !user.isRestricted &&
        !user.isUltraRestricted &&
        !user.isStranger &&
        !user.deleted
      return { class: admitted ? "admitted" : "outsider", name: user.name }
    }),
    Effect.catch((error) =>
      Effect.logWarning("Couldn't look up a Slack user").pipe(
        Effect.annotateLogs({ reason: error.message }),
        Effect.as<SlackAuthor>({ class: "outsider", name: userId }),
      ),
    ),
  )

const isObject = (u: unknown): u is Record<string, unknown> =>
  typeof u === "object" && u !== null && !Array.isArray(u)

/** The Slack message's own fields, which janitor reads beyond `effect/chat`'s. */
const slackFields = (message: ChatMessages.ChatMessage): Record<string, unknown> =>
  isObject(message.raw) ? message.raw : {}

/**
 * Whether janitor counts the message as a bot's: `effect/chat` flags a bot
 * user, a `bot_id` and the bot's own messages, and a message an app posted
 * as a user carries an `app_id` too.
 */
export const isBotMessage = (message: ChatMessages.ChatMessage): boolean =>
  message.author.isBot || slackFields(message)["app_id"] !== undefined

/**
 * Subtypes that are still a person's new message: one with files, and a
 * thread reply also sent to the channel. `effect/chat` passes on others,
 * such as `me_message`, that janitor drops.
 */
const MESSAGE_SUBTYPES: ReadonlySet<unknown> = new Set(["file_share", "thread_broadcast"])

/**
 * Whether janitor reads the message at all: one without a subtype, or with
 * one of `MESSAGE_SUBTYPES`. A history reads bots' `bot_message`s too.
 */
export const isNewMessage = (
  message: ChatMessages.ChatMessage,
  options?: { readonly botMessages?: boolean },
): boolean => {
  const subtype = slackFields(message)["subtype"]
  return (
    subtype === undefined ||
    MESSAGE_SUBTYPES.has(subtype) ||
    (options?.botMessages === true && subtype === "bot_message")
  )
}

/** Whether the message was edited: an edit is not a new message. */
export const isEdited = (message: ChatMessages.ChatMessage): boolean =>
  slackFields(message)["edited"] !== undefined

/** Whether the message is in a one-to-one conversation with the bot. */
export const isDirectMessage = (message: ChatMessages.ChatMessage): boolean =>
  slackFields(message)["channel_type"] === "im"

/** The thread's root `ts`: the message's own when it starts a thread. */
export const threadTs = (
  message: ChatMessages.ChatMessage,
): Option.Option<{
  readonly channel: string
  readonly threadTs: string
}> =>
  Option.map(SlackChat.parts(message.thread), (parts) => ({
    channel: parts.channel,
    threadTs: parts.threadTs ?? message.id,
  }))

/** An `effect/chat` Slack message as a session's, with mentions of the bot removed. */
export const toChatMessage = (
  message: ChatMessages.ChatMessage,
  author: { readonly id: string } & SlackAuthor,
  mentioned: boolean,
): ChatMessage => ({
  id: message.id,
  author: { id: author.id, name: author.name, class: author.class },
  text: withoutMentions(message, (mention) => mention.isSelf).replace(/^\s+/, ""),
  mentionsBot: mentioned,
  sentAt: message.timestamp,
  attachments: message.attachments.map((file) => ({
    id: file.id,
    name: file.name ?? file.id,
    mediaType: file.contentType ?? "application/octet-stream",
    size: Math.max(0, Math.floor(file.size ?? 0)),
  })),
})
