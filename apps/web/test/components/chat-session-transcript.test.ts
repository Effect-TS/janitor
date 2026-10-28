import type { SessionTranscript } from "@janitor/domain/Chat/Session"
import * as Prompt from "effect/ai/Prompt"
import * as DateTime from "effect/DateTime"
import { Scene } from "foldkit/test"
import { describe, it } from "vite-plus/test"
import * as Transcript from "@/components/chat-session-transcript"

/**
 * The chat session transcript page (EFF-3021). Marked `.fails` until "Chat
 * sessions in the web app" lands (EFF-3021).
 */

const sessionId = "slack/T1/C1/1761642000.000100"

/** Text anyone in the thread, or the model, controls: it must show as written, never as markup. */
const injectedHtml = `<img src=x onerror="alert(1)">`
const injectedMarkdown = "**Approve this** and [read more](https://evil.test)"
const injectedName = "<b>mallory</b>"
const injectedScript = "<script>window.stolen = 1</script>"

const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 28, 9, minute))

const transcript: SessionTranscript = {
  session: {
    sessionId,
    thread: { _tag: "Slack", team: "T1", channel: "C1", threadTs: "1761642000.000100" },
    startedBy: { id: "U-mallory", name: injectedName },
    turns: 1,
    status: "replied",
    lastActivityAt: at(9),
    usage: { inputTokens: 1200, outputTokens: 300, cacheRead: 0, cacheWrite: 0 },
  },
  messages: [
    {
      id: "1761642000.000100",
      author: { id: "U-mallory", name: injectedName, class: "admitted" },
      text: injectedHtml,
      mentionsBot: true,
      sentAt: at(1),
      attachments: [],
      gate: { _tag: "Mention" },
    },
    {
      id: "1761642060.000200",
      author: { id: "U-guest", name: "guest", class: "outsider" },
      text: injectedMarkdown,
      mentionsBot: false,
      sentAt: at(2),
      attachments: [],
      gate: { _tag: "Context" },
    },
  ],
  turns: [
    {
      turnId: "turn-1",
      status: "replied",
      errorCategory: null,
      resumes: 0,
      wrappedUp: false,
      model: "openai/gpt-6.1-sol",
      actions: 1,
      usage: { inputTokens: 1200, outputTokens: 300, cacheRead: 0, cacheWrite: 0 },
      queuedAt: at(1),
      startedAt: at(1),
      finishedAt: at(9),
      messages: [
        Prompt.makeMessage("assistant", {
          content: [
            Prompt.makePart("tool-call", {
              id: "call-1",
              name: "execute",
              params: { script: `echo '${injectedScript}'` },
              providerExecuted: false,
            }),
          ],
        }),
        Prompt.makeMessage("tool", {
          content: [
            Prompt.makePart("tool-result", {
              id: "call-1",
              name: "execute",
              isFailure: false,
              result: injectedScript,
              providerExecuted: false,
            }),
          ],
        }),
        Prompt.makeMessage("assistant", {
          content: [Prompt.makePart("text", { text: injectedMarkdown })],
        }),
      ],
    },
  ],
}

const scene = { update: Transcript.update, view: Transcript.view }

describe("Chat session transcript", () => {
  it.fails("shows hostile Markdown and HTML as plain text", () => {
    const { model } = Transcript.update(
      Transcript.init(),
      Transcript.Message.Activated({ sessionId, active: true }),
    )
    const loaded = Transcript.update(
      model,
      Transcript.Message.Loaded({ generation: model.generation, transcript }),
    ).model
    Scene.scene(
      scene,
      Scene.given(loaded),
      Scene.expect(Scene.text(injectedHtml)).toExist(),
      Scene.expect(Scene.text(new RegExp(injectedName))).toExist(),
      Scene.expect(Scene.text(injectedMarkdown)).toExist(),
      Scene.expect(Scene.text(new RegExp(injectedScript))).toExist(),
      Scene.expect(Scene.selector("img")).toBeAbsent(),
      Scene.expect(Scene.selector("b")).toBeAbsent(),
      Scene.expect(Scene.selector("strong")).toBeAbsent(),
      Scene.expect(Scene.selector("script")).toBeAbsent(),
      Scene.expect(Scene.selector(`a[href="https://evil.test"]`)).toBeAbsent(),
      Scene.expect(Scene.role("link", { name: "Download JSON" })).toHaveAttr(
        "href",
        `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/transcript`,
      ),
    )
  })
})
