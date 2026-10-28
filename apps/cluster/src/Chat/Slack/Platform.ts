import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { ChatPlatform, ChatPlatformError, type ChatThread, readLimited } from "../Platform.ts"
import {
  decode,
  isExtShared,
  lookUpAuthor,
  MESSAGE_SUBTYPES,
  mentionsBot,
  SlackApi,
  type SlackApiError,
  type SlackAuthor,
  SlackMessage,
  toChatMessage,
} from "./Api.ts"
import { SlackConfig } from "./Config.ts"

/** `markdown_text`'s limit on one message. */
const CHUNK_CHARACTERS = 12_000

/** A reply that needs more messages than this is uploaded as a `.md` file instead. */
const MAX_CHUNKS = 3

const BETWEEN_POSTS = Duration.seconds(1)

/** Marks janitor's own posts, so they read as the bot's in a thread's history. */
const metadata = (kind: "status" | "reply") => ({
  event_type: "janitor_output",
  event_payload: { kind },
})

const noUnfurls = { unfurl_links: false, unfurl_media: false }

const Posted = Schema.Struct({ ts: Schema.String })

/**
 * Splits Markdown into chunks of at most `max` characters, on line breaks
 * where it can. A code fence open at a split is closed at the end of the
 * chunk and opened again at the start of the next.
 */
export const chunkMarkdown = (text: string, max: number): ReadonlyArray<string> => {
  // Room for the "\n```" that closes a fence at a split.
  const limit = max - 4
  const chunks: Array<string> = []
  let lines: Array<string> = []
  let size = 0
  let fence: string | undefined
  const flush = () => {
    // A fence opened on the chunk's last line moves whole to the next chunk.
    const opener = fence !== undefined && lines.length > 1 && lines.at(-1) === fence
    if (opener) lines.pop()
    const chunk = lines.join("\n") + (fence === undefined || opener ? "" : "\n```")
    if (chunk.trim().length > 0) chunks.push(chunk)
    lines = fence === undefined ? [] : [fence]
    size = fence === undefined ? 0 : fence.length
  }
  for (const line of text.split("\n")) {
    const isFence = /^\s*```/.test(line)
    let rest = line
    for (;;) {
      const separator = lines.length > 0 ? 1 : 0
      if (size + separator + rest.length <= limit) {
        lines.push(rest)
        size += separator + rest.length
        break
      }
      if (lines.length > (fence === undefined ? 0 : 1)) {
        flush()
        // The split closed this fence already.
        if (isFence && fence !== undefined) {
          lines = []
          size = 0
          break
        }
        continue
      }
      // A line longer than a chunk: cut it where it must.
      const cut = Math.max(1, limit - size - separator)
      lines.push(rest.slice(0, cut))
      rest = rest.slice(cut)
      flush()
    }
    if (isFence) fence = fence === undefined ? line.trim() : undefined
  }
  if (lines.length > (fence === undefined ? 0 : 1)) flush()
  return chunks
}

const platformError = (error: SlackApiError | ChatPlatformError) =>
  error._tag === "ChatPlatformError" ? error : new ChatPlatformError({ message: error.message })

const slackThread = (
  thread: ChatThread,
): Effect.Effect<Extract<ChatThread, { readonly _tag: "Slack" }>, ChatPlatformError> =>
  thread._tag === "Slack"
    ? Effect.succeed(thread)
    : Effect.fail(new ChatPlatformError({ message: "Not a Slack thread" }))

/**
 * Thread messages read per `conversations.replies` page. Slack pages a thread
 * from its start, so the backfill reads to the last page and keeps the latest.
 */
const PAGE_SIZE = 200

/** How long a channel's Slack Connect check holds before the next write checks again. */
const SHARED_CHECK_TTL = Duration.minutes(1)

const make = Effect.gen(function* () {
  const api = yield* SlackApi
  const config = yield* SlackConfig

  // Channels checked recently: whether each is shared, and when it was checked.
  const sharedChecks = new Map<string, { readonly shared: boolean; readonly at: number }>()

  /**
   * The thread, for a write. A channel shared with another organization after
   * its session started gets nothing more from a running turn: each write
   * checks it, at most once a minute per channel. A failed check fails the
   * write.
   */
  const writable = (thread: ChatThread) =>
    Effect.gen(function* () {
      const slack = yield* slackThread(thread)
      const now = yield* Clock.currentTimeMillis
      const checked = sharedChecks.get(slack.channel)
      const shared =
        checked !== undefined && now - checked.at < Duration.toMillis(SHARED_CHECK_TTL)
          ? checked.shared
          : yield* isExtShared(api, slack.channel).pipe(
              Effect.tap((shared) =>
                Effect.sync(() => sharedChecks.set(slack.channel, { shared, at: now })),
              ),
              Effect.mapError(platformError),
            )
      if (shared)
        return yield* new ChatPlatformError({
          message: "The channel is shared with another organization",
        })
      return slack
    })

  const post = (thread: ChatThread, fields: Record<string, unknown>) =>
    writable(thread).pipe(
      Effect.flatMap(({ channel, threadTs }) =>
        api.call(
          "chat.postMessage",
          { channel, thread_ts: threadTs, ...noUnfurls, ...fields },
          { write: true },
        ),
      ),
      Effect.flatMap(decode("chat.postMessage", Posted)),
      Effect.map(({ ts }) => ts),
      Effect.mapError(platformError),
    )

  const uploadFile = (
    thread: ChatThread,
    file: { readonly name: string; readonly content: string },
  ) =>
    Effect.gen(function* () {
      const { channel, threadTs } = yield* writable(thread)
      const bytes = new TextEncoder().encode(file.content)
      const target = yield* api
        .call("files.getUploadURLExternal", { filename: file.name, length: bytes.length })
        .pipe(
          Effect.flatMap(
            decode(
              "files.getUploadURLExternal",
              Schema.Struct({ upload_url: Schema.String, file_id: Schema.String }),
            ),
          ),
        )
      yield* api.http
        .execute(
          HttpClientRequest.post(target.upload_url).pipe(
            HttpClientRequest.bodyUint8Array(bytes, "text/markdown"),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.mapError(() => new ChatPlatformError({ message: "The file upload failed" })),
        )
      yield* api.call(
        "files.completeUploadExternal",
        {
          files: [{ id: target.file_id, title: file.name }],
          channel_id: channel,
          thread_ts: threadTs,
        },
        { write: true },
      )
    }).pipe(Effect.mapError(platformError))

  const history = (thread: ChatThread, limit: number) =>
    Effect.gen(function* () {
      const { channel, threadTs } = yield* slackThread(thread)
      const botUserId = yield* api.botUserId
      const messages: Array<SlackMessage> = []
      let cursor: string | undefined
      for (;;) {
        const body = yield* api
          .call("conversations.replies", { channel, ts: threadTs, limit: PAGE_SIZE, cursor })
          .pipe(
            Effect.flatMap(
              decode(
                "conversations.replies",
                Schema.Struct({
                  messages: Schema.Array(Schema.Unknown),
                  response_metadata: Schema.optionalKey(
                    Schema.Struct({ next_cursor: Schema.optionalKey(Schema.String) }),
                  ),
                }),
              ),
            ),
          )
        for (const raw of body.messages) {
          const message = Schema.decodeUnknownOption(SlackMessage)(raw)
          if (message._tag === "None") continue
          const { subtype, user, bot_id } = message.value
          if (subtype !== undefined && subtype !== "bot_message" && !MESSAGE_SUBTYPES.has(subtype))
            continue
          if (user === undefined && bot_id === undefined) continue
          messages.push(message.value)
          if (messages.length > limit) messages.shift()
        }
        cursor = body.response_metadata?.next_cursor
        if (!cursor) break
      }
      const isBot = (message: SlackMessage) =>
        message.bot_id !== undefined || message.app_id !== undefined || message.user === botUserId
      const people = new Set(
        messages.filter((message) => !isBot(message)).map((message) => message.user!),
      )
      const authors = new Map(
        yield* Effect.forEach(
          people,
          (id) =>
            Effect.map(
              lookUpAuthor(api, config.workspaceId, id),
              (author) => [id, author] as const,
            ),
          { concurrency: 5 },
        ),
      )
      const result = messages.map((message) => {
        const id = message.user ?? message.bot_id ?? ""
        const author: SlackAuthor = isBot(message)
          ? { class: "bot", name: message.username ?? "bot" }
          : authors.get(id)!
        return toChatMessage(
          message,
          { id, ...author },
          botUserId,
          mentionsBot(message.text ?? "", botUserId),
        )
      })
      return result
    }).pipe(Effect.mapError(platformError))

  return ChatPlatform.of({
    postStatus: (thread, text) => post(thread, { text, metadata: metadata("status") }),
    editStatus: (thread, messageId, text) =>
      writable(thread).pipe(
        Effect.flatMap(({ channel }) =>
          api.call(
            "chat.update",
            { channel, ts: messageId, text, metadata: metadata("status") },
            { write: true },
          ),
        ),
        Effect.asVoid,
        Effect.mapError(platformError),
      ),
    postReply: (thread, text) => {
      const chunks = chunkMarkdown(text, CHUNK_CHARACTERS)
      if (chunks.length > MAX_CHUNKS) return uploadFile(thread, { name: "reply.md", content: text })
      return Effect.forEach(
        chunks,
        (chunk, index) =>
          (index === 0 ? Effect.void : Effect.sleep(BETWEEN_POSTS)).pipe(
            Effect.andThen(post(thread, { markdown_text: chunk, metadata: metadata("reply") })),
          ),
        { discard: true },
      )
    },
    uploadFile,
    download: (_thread, attachment, maxBytes) =>
      Effect.gen(function* () {
        const { file } = yield* api.call("files.info", { file: attachment.id }).pipe(
          Effect.flatMap(
            decode(
              "files.info",
              Schema.Struct({
                file: Schema.Struct({
                  url_private: Schema.optionalKey(Schema.String),
                  url_private_download: Schema.optionalKey(Schema.String),
                }),
              }),
            ),
          ),
        )
        const url = file.url_private_download ?? file.url_private
        if (url === undefined)
          return yield* new ChatPlatformError({ message: "The file has no download link" })
        const response = yield* api.http.execute(HttpClientRequest.get(url)).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.mapError(() => new ChatPlatformError({ message: "The download failed" })),
        )
        return yield* readLimited(response.stream, maxBytes)
      }).pipe(Effect.mapError(platformError)),
    history,
  })
})

/**
 * Slack's `ChatPlatform`, over the Slack Web API with the bot token. A
 * rate-limited call is retried after its `Retry-After`. A write whose outcome
 * is unknown (a 5xx or a broken response) is never retried, and one Slack
 * refuses fails at once. Replies go out as `markdown_text`, up to 12,000
 * characters a message and a second apart, with code fences kept balanced;
 * one that needs more than three messages is uploaded as `reply.md`.
 * janitor's posts carry a metadata marker and never unfurl links.
 */
export const layer: Layer.Layer<ChatPlatform, never, SlackConfig | HttpClient.HttpClient> =
  Layer.effect(ChatPlatform, make).pipe(Layer.provide(SlackApi.layer))
