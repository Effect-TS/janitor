import * as Chat from "effect/chat/Chat"
import type * as ChatThreads from "effect/chat/ChatThread"
import { mentionsSelf } from "effect/chat/ChatMessage"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as HttpClient from "effect/http/HttpClient"
import * as SlackChat from "@effect/chat-slack/SlackChat"
import {
  ChatPlatform,
  ChatPlatformError,
  type ChatThread,
  downloadAttachment,
  fromChatError,
  latestMessages,
  postMarkdown,
} from "../Platform.ts"
import { address, isBotMessage, lookUpAuthor, type SlackAuthor, toChatMessage } from "./Api.ts"
import { SlackConfig } from "./Config.ts"

/** A reply that needs more messages than this goes on in `reply.md`. */
const MAX_PARTS = 3

const slackAddress = (
  thread: ChatThread,
): Effect.Effect<ChatThreads.ChatThread, ChatPlatformError> =>
  thread._tag === "Slack"
    ? Effect.succeed(address(thread))
    : Effect.fail(new ChatPlatformError({ message: "Not a Slack thread" }))

const make = Effect.gen(function* () {
  const chat = yield* Chat.Chat
  const slack = yield* SlackChat.SlackChat
  const config = yield* SlackConfig
  const provide = Effect.provideService(Chat.Chat, chat)

  const history = (thread: ChatThread, limit: number) =>
    Effect.gen(function* () {
      const messages = yield* latestMessages(yield* slackAddress(thread), limit)
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
        return toChatMessage(message, { id, ...author }, mentionsSelf(message))
      })
    }).pipe(provide)

  return ChatPlatform.of({
    postStatus: (thread, text) =>
      slackAddress(thread).pipe(
        Effect.flatMap((to) => Effect.mapError(chat.post(to, { markdown: text }), fromChatError)),
        Effect.map(({ id }) => id),
      ),
    editStatus: (thread, messageId, text) =>
      slackAddress(thread).pipe(
        Effect.flatMap((to) =>
          Effect.mapError(chat.edit(to, messageId, { markdown: text }), fromChatError),
        ),
      ),
    deleteStatus: (thread, messageId) =>
      slackAddress(thread).pipe(
        Effect.flatMap((to) => Effect.mapError(chat.delete(to, messageId), fromChatError)),
      ),
    // Slack has no reply to a message: `replyTo` is for Discord.
    postReply: (thread, text, options) =>
      slackAddress(thread).pipe(
        Effect.flatMap((to) =>
          Effect.mapError(
            postMarkdown(to, text, { maxParts: MAX_PARTS, files: options?.files ?? [] }),
            fromChatError,
          ),
        ),
        provide,
      ),
    download: (thread, attachment, maxBytes) =>
      slackAddress(thread).pipe(
        Effect.flatMap((to) =>
          downloadAttachment(to, { id: attachment.id, size: attachment.size }, maxBytes),
        ),
        provide,
      ),
    history,
  })
})

/**
 * Slack's `ChatPlatform`, over `effect/chat` with `@effect/chat-slack`'s
 * adapter. Replies go out as Markdown through `ChatMarkdown.post`, split
 * at block boundaries into up to three messages a second apart, the rest
 * uploaded as `reply.md`; a reply's files go with its last message. The
 * adapter retries what is safe to retry, never mentions anyone, and never
 * unfurls links. The backfill admits each author with `users.info`.
 */
export const layer: Layer.Layer<
  ChatPlatform,
  never,
  Chat.Chat | SlackChat.SlackChat | SlackConfig
> = Layer.effect(ChatPlatform, make)

/** Slack's `ChatPlatform` from its settings, with its own `Chat` and the Slack adapter. */
export const layerFrom = (
  config: SlackConfig["Service"],
): Layer.Layer<ChatPlatform, never, HttpClient.HttpClient> =>
  layer.pipe(
    Layer.provide(SlackChat.layer({ botToken: config.botToken, teamId: config.workspaceId })),
    Layer.provideMerge(Chat.layer),
    Layer.provide(SlackConfig.layerFrom(config)),
  )
