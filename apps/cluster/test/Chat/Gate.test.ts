import { assert, describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import { BOT_AUTHOR_ID, gateSignals } from "../../src/Chat/Gate.ts"
import type { AuthorClass, ChatMessage } from "../../src/Chat/Platform.ts"

/** The structural signals the reply gate reads off its window of thread messages. */

const ada = { id: "ada", name: "Ada", class: "admitted" } as const
const grace = { id: "grace", name: "Grace", class: "outsider" } as const
const janitor = { id: BOT_AUTHOR_ID, name: "janitor", class: "bot" } as const
const otherBot = { id: "other-bot", name: "other-bot", class: "bot" } as const

const message = (
  id: string,
  author: { readonly id: string; readonly name: string; readonly class: AuthorClass },
  answers?: string,
): ChatMessage => ({
  id,
  author,
  text: id,
  mentionsBot: false,
  sentAt: DateTime.makeUnsafe("2026-10-29T12:00:00.000Z"),
  attachments: [],
  ...(answers === undefined ? {} : { answers }),
})

describe("reply gate signals", () => {
  it("follows janitor's reply only when janitor itself answered the newest message's author", () => {
    const question = message("question", ada)
    const followUp = message("follow-up", ada)
    assert.isTrue(
      gateSignals([question, message("reply", janitor, ada.id), followUp]).followsBotReplyTo,
    )
    assert.isFalse(
      gateSignals([question, message("reply", otherBot, ada.id), followUp]).followsBotReplyTo,
    )
  })

  it("counts the people who have spoken, outsiders included and bots aside", () => {
    const signals = gateSignals([
      message("1", ada),
      message("2", janitor, ada.id),
      message("3", grace),
      message("4", otherBot),
      message("5", ada),
    ])
    assert.strictEqual(signals.humansInThread, 2)
  })
})
