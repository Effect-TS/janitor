import * as DiscordChat from "@effect/chat-discord/DiscordChat"
import type * as ChatAdapter from "effect/chat/ChatAdapter"
import type { ChatError } from "effect/chat/ChatError"
import * as ChatMarkdown from "effect/chat/ChatMarkdown"
import type * as ChatMessages from "effect/chat/ChatMessage"
import type * as ChatThreads from "effect/chat/ChatThread"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"

/**
 * A turn's reply, posted with `ChatMarkdown.post` (EFF-3018): split at
 * block boundaries into a platform's share of messages, paced by its
 * adapter, the rest uploaded as `reply.md`.
 */

/** The file the rest of a reply too long for its messages is uploaded as. */
export const REPLY_FILE = "reply.md"

/** How many messages a reply takes before the rest goes on in `reply.md`. */
const MAX_PARTS: Readonly<Record<string, number>> = { slack: 3, discord: 5 }

/** The note naming the files that couldn't be posted with a reply. */
const unattachedNote = (files: ReadonlyArray<{ readonly name: string }>): string =>
  `(Couldn't attach ${files.map((file) => file.name).join(", ")}.)`

/** A posted reply: when its final part was published, and its text as posted, notes included. */
export interface PostedReply {
  readonly postedAt: DateTime.Utc
  readonly text: string
}

/**
 * Discord's answer to a reply whose message is gone: an invalid form body
 * (50035) naming `message_reference`, or an unknown message.
 */
const isUnknownReference = (error: ChatError): boolean =>
  error.reason._tag === "NotFound" ||
  (error.reason._tag === "InvalidRequest" && error.reason.detail === "50035")

/** A Discord id. */
const SNOWFLAKE = /^\d+$/

/** The users a Discord reply names, `<@id>` or the older `<@!id>`: a reply may ping them. */
const namedUsers = (text: string): ReadonlyArray<string> =>
  Array.from(new Set(Array.from(text.matchAll(/<@!?(\d+)>/g), (match) => match[1]!)))

/**
 * Posts a reply and returns when its final part was published, with the
 * text that went out. `files` go with the last message, or with
 * `reply.md`. When the platform refuses them, the last message goes
 * without them, ending in a note naming them, and the text returned ends
 * with the note too. Nothing already posted is posted again, so a failure
 * after a lost answer fails the reply.
 *
 * On Discord the first message answers `replyTo`, the message that started
 * the turn. When that message started the thread, or is an approval, the
 * reply mentions its author instead, since a reply from inside the thread
 * can't point at it. A reply may ping the users it names and the author it
 * answers, never a role or `@everyone`. Slack has no reply to a message.
 */
export const postReply = Effect.fnUntraced(function* (
  thread: ChatThreads.ChatThread,
  text: string,
  options: {
    readonly replyTo?: { readonly messageId: string; readonly authorId: string } | undefined
    readonly files?: ReadonlyArray<ChatAdapter.File> | undefined
  } = {},
) {
  const files = options.files ?? []
  let unattached = false
  const post = (
    answer?: { readonly lead: string } | { readonly replyTo: ChatMessages.ReplyTo },
  ) => {
    const lead = answer !== undefined && "lead" in answer ? answer.lead : undefined
    // A fence opening the reply must stay at the start of its line.
    const markdown =
      lead === undefined ? text : `${lead}${/^\s*```/.test(text) ? "\n" : " "}${text}`
    return ChatMarkdown.post(thread, markdown, {
      maxParts: MAX_PARTS[thread.platform] ?? 1,
      overflow: { file: { name: REPLY_FILE } },
      ...(answer !== undefined && "replyTo" in answer ? { replyTo: answer.replyTo } : {}),
      ...(files.length === 0
        ? {}
        : {
            files,
            unattachedNote: (refused: ReadonlyArray<ChatAdapter.File>) => {
              unattached = true
              return `\n\n${unattachedNote(refused)}`
            },
          }),
    }).pipe(
      DiscordChat.withPostOptions({
        notify: { users: namedUsers(markdown), repliedUser: true },
      }),
    )
  }
  const replyTo = options.replyTo
  const result = yield* thread.platform !== "discord" || replyTo === undefined
    ? post()
    : // A thread started from a message shares its id. An approval's id
      // (EFF-3163) is no message's, and Discord refuses it.
      replyTo.messageId === thread.id || !SNOWFLAKE.test(replyTo.messageId)
      ? post({ lead: `<@${replyTo.authorId}>` })
      : // Discord refuses a reply to a message deleted since. Janitor used to
        // send `fail_if_not_exists: false`, which the adapter can't, so the
        // reply goes out again as a plain message, as long as nothing went
        // out yet (reported on EFF-3790).
        post({ replyTo }).pipe(
          Effect.catchIf(
            (error) =>
              error.posted.length === 0 &&
              error.cause._tag === "Chat" &&
              isUnknownReference(error.cause.error),
            () => post(),
          ),
        )
  if (unattached) yield* Effect.logWarning("Couldn't post a chat reply's files")
  const last = result.parts.at(-1)
  return {
    postedAt: last === undefined ? yield* DateTime.now : last.timestamp,
    text: unattached
      ? text === ""
        ? unattachedNote(files)
        : `${text}\n\n${unattachedNote(files)}`
      : text,
  }
})
