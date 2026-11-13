import * as Chat from "effect/chat/Chat"
import type * as ChatMessages from "effect/chat/ChatMessage"
import type * as ChatThreads from "effect/chat/ChatThread"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as SlackChat from "@effect/chat-slack/SlackChat"
import type { AuthorClass } from "@janitor/domain/Chat/Session"
import { sessionMessage } from "../Message.ts"
import type { Backfill } from "../Session.ts"
import type { SlackConfig } from "./Config.ts"

/**
 * What Slack ingress and the sessions share (EFF-3019): the admission rule,
 * which messages janitor reads, and the backfill of a thread.
 */

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

/**
 * Connects Slack to `Chat`, registering its adapter, and returns the sessions' backfill
 * for Slack threads: the latest new messages, bots' included, each author
 * admitted with `users.info`.
 */
export const connect = Effect.fnUntraced(function* (config: SlackConfig["Service"]) {
  const slack = Context.get(
    yield* Layer.build(SlackChat.layer({ botToken: config.botToken, teamId: config.workspaceId })),
    SlackChat.SlackChat,
  )
  const chat = yield* Chat.Chat
  return ((thread: ChatThreads.ChatThread, limit: number) =>
    Effect.gen(function* () {
      const messages = yield* chat.history(thread, { direction: "backward" }).pipe(
        Stream.filter((message) => isNewMessage(message, { botMessages: true })),
        Stream.take(limit),
        Stream.runCollect,
        Effect.map((messages) => Array.from(messages).reverse()),
      )
      const people = new Set(
        messages.filter((message) => !isBotMessage(message)).map(({ author }) => author.id),
      )
      const authors = new Map(
        yield* Effect.forEach(
          people,
          (id) =>
            Effect.map(
              lookUpAuthor(slack, config.workspaceId, id),
              (author) => [id, author] as const,
            ),
          { concurrency: 5 },
        ),
      )
      return messages.map((message) => {
        const id = message.author.id
        const author: SlackAuthor = isBotMessage(message)
          ? { class: "bot", name: message.author.name ?? "bot" }
          : authors.get(id)!
        return sessionMessage(message, { id, ...author })
      })
    })) satisfies Backfill
})
