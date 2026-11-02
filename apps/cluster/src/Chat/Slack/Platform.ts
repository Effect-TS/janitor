import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import {
  type ChatFile,
  ChatPlatform,
  ChatPlatformError,
  type ChatThread,
  logUnattached,
  notingUnattached,
  readLimited,
  replyMarkdown,
} from "../Platform.ts"
import {
  decode,
  lookUpAuthor,
  MESSAGE_SUBTYPES,
  mentionsBot,
  noUnfurls,
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

/** The call surely didn't land: Slack refused it or rate limited it. Else it may have. */
const refused = (error: SlackApiError | ChatPlatformError) =>
  error._tag === "ChatPlatformError" || error.disposition !== "uncertain"

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

const make = Effect.gen(function* () {
  const api = yield* SlackApi
  const config = yield* SlackConfig

  const post = (thread: ChatThread, fields: Record<string, unknown>) =>
    slackThread(thread).pipe(
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

  /** Uploads `file` to Slack, unshared; succeeds with its file id. */
  const stage = (file: ChatFile) =>
    Effect.gen(function* () {
      const target = yield* api
        .call("files.getUploadURLExternal", { filename: file.name, length: file.content.length })
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
            HttpClientRequest.bodyUint8Array(file.content, file.contentType),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.mapError(() => new ChatPlatformError({ message: "The file upload failed" })),
        )
      return { id: target.file_id, title: file.name }
    })

  /**
   * Shares staged files in the thread as one message, with `text` as a
   * `markdown` block, which renders as `markdown_text` does.
   */
  const share = (
    thread: ChatThread,
    files: ReadonlyArray<{ readonly id: string; readonly title: string }>,
    text?: string,
  ) =>
    slackThread(thread).pipe(
      Effect.flatMap(({ channel, threadTs }) =>
        api.call(
          "files.completeUploadExternal",
          {
            files,
            channel_id: channel,
            thread_ts: threadTs,
            blocks: text === undefined ? undefined : [{ type: "markdown", text }],
          },
          { write: true },
        ),
      ),
    )

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
      return messages.map((message) => {
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
    }).pipe(Effect.mapError(platformError))

  return ChatPlatform.of({
    postStatus: (thread, text) => post(thread, { text, metadata: metadata("status") }),
    editStatus: (thread, messageId, text) =>
      slackThread(thread).pipe(
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
    deleteStatus: (thread, messageId) =>
      slackThread(thread).pipe(
        Effect.flatMap(({ channel }) =>
          api.call("chat.delete", { channel, ts: messageId }, { write: true }),
        ),
        Effect.asVoid,
        Effect.mapError(platformError),
      ),
    postReply: (thread, text, options) => {
      const files = options?.files ?? []
      const chunks = chunkMarkdown(text, CHUNK_CHARACTERS)
      const overflow = chunks.length > MAX_CHUNKS
      /** Posts `chunks` a second apart, and after an earlier message; succeeds with the last one's time. */
      const postChunks = (chunks: ReadonlyArray<string>, afterEarlier = false) =>
        Effect.forEach(chunks, (chunk, index) =>
          (index === 0 && !afterEarlier ? Effect.void : Effect.sleep(BETWEEN_POSTS)).pipe(
            Effect.andThen(post(thread, { markdown_text: chunk, metadata: metadata("reply") })),
          ),
        ).pipe(
          Effect.flatMap((posted) => {
            const last = posted.at(-1)
            return last === undefined
              ? DateTime.now
              : Effect.succeed(DateTime.makeUnsafe(Math.floor(Number(last) * 1000)))
          }),
        )
      // The files go with the reply's last chunk, or with its `reply.md` when
      // it is too long for messages.
      const attached = overflow ? [replyMarkdown(text), ...files] : files
      if (attached.length === 0)
        return postChunks(chunks).pipe(Effect.map((postedAt) => ({ postedAt, text })))
      const earlier = overflow ? [] : chunks.slice(0, -1)
      const last = overflow ? undefined : chunks.at(-1)
      return Effect.gen(function* () {
        // Staged before any text goes out, so a refused upload posts nothing.
        const staged = yield* Effect.forEach(attached, stage).pipe(Effect.result)
        if (staged._tag === "Success") {
          yield* postChunks(earlier)
          if (earlier.length > 0) yield* Effect.sleep(BETWEEN_POSTS)
        }
        const shared =
          staged._tag === "Failure"
            ? staged
            : yield* share(thread, staged.success, last).pipe(Effect.result)
        // File uploads do not return a message timestamp; completion is a
        // conservative boundary rather than backdating to the request.
        if (shared._tag === "Success") return { postedAt: yield* DateTime.now, text }
        // A lost answer to sharing may have posted the message: never again.
        // Staging posts nothing, so a lost answer there is safe to recover from.
        if (files.length === 0 || (staged._tag === "Success" && !refused(shared.failure)))
          return yield* platformError(shared.failure)
        // Slack refused the files, so what their message carried goes out as
        // text, naming them: the whole reply when it was `reply.md`, however
        // many messages that takes. Nothing already out is posted again.
        yield* logUnattached(platformError(shared.failure))
        const noted = notingUnattached(text, files)
        const postedAt = yield* postChunks(
          chunkMarkdown(overflow ? noted : notingUnattached(last ?? "", files), CHUNK_CHARACTERS),
          earlier.length > 0,
        )
        return { postedAt, text: noted }
      })
    },
    uploadFile: (thread, file) =>
      stage(file).pipe(
        Effect.flatMap((staged) => share(thread, [staged])),
        Effect.asVoid,
        Effect.mapError(platformError),
      ),
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
 * one that needs more than three messages is uploaded as `reply.md`. A
 * reply's files are shared with its last message's text, or with its
 * `reply.md`, uploaded before any of its text is posted.
 * janitor's posts carry a metadata marker and never unfurl links.
 */
export const layer: Layer.Layer<ChatPlatform, never, SlackConfig | HttpClient.HttpClient> =
  Layer.effect(ChatPlatform, make).pipe(Layer.provide(SlackApi.layer))
