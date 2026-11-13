import { assert, describe, it } from "@effect/vitest"
import * as DiscordChat from "@effect/chat-discord/DiscordChat"
import type { ChatMessage } from "effect/chat/ChatMessage"
import * as DateTime from "effect/DateTime"
import type { ChatThread } from "@janitor/domain/Chat/Session"
import { address, attachmentSource, sessionMessage } from "../../src/Chat/Message.ts"

const author = { id: "600", name: "ada", class: "admitted" } as const

/** A Discord message in channel `channel`, as `effect/chat` reads it. */
const discordMessage = (channel: string, overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "1001",
  thread: DiscordChat.thread(channel),
  author: { id: "600", name: "ada", isBot: false, isSelf: false },
  text: "",
  mentions: [],
  attachments: [],
  timestamp: DateTime.makeUnsafe(0),
  raw: null,
  ...overrides,
})

describe("sessionMessage", () => {
  it("cuts the bot's mentions by their offsets and keeps the others", () => {
    const text = "<@300> ask <@601> about `<@300>`"
    const message = sessionMessage(
      discordMessage("500", {
        text,
        mentions: [
          { kind: "user", id: "300", start: 0, end: 6, isSelf: true },
          { kind: "user", id: "601", start: 11, end: 17, isSelf: false },
        ],
      }),
      author,
    )
    assert.strictEqual(message.text, "ask <@601> about `<@300>`")
    assert.isTrue(message.mentionsBot)
  })

  it("a reply to the bot mentions it without a ping", () => {
    const message = sessionMessage(
      discordMessage("500", { text: "thanks", replyTo: { messageId: "999", authorId: "300" } }),
      author,
      { botUserId: "300" },
    )
    assert.isTrue(message.mentionsBot)
    assert.strictEqual(message.answers, "300")
  })

  it("a Discord attachment is downloaded from its message's channel, the parent's for an opener", () => {
    const thread: ChatThread = { _tag: "Discord", guild: "100", threadId: "500" }
    const [attachment] = sessionMessage(
      discordMessage("400", {
        attachments: [{ id: "1001/77", name: "plot.png", contentType: "image/png", size: 6 }],
      }),
      author,
    ).attachments
    assert.deepStrictEqual(attachment, {
      id: "400/1001/77",
      name: "plot.png",
      mediaType: "image/png",
      size: 6,
    })
    assert.deepStrictEqual(attachmentSource(address(thread), attachment!), {
      thread: DiscordChat.thread("400"),
      attachment: { id: "1001/77", size: 6 },
    })
  })
})
