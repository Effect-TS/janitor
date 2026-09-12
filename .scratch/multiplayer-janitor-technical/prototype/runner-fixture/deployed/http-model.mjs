import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { LLMClient, RequestExecutor } from "@opencode/ai/route"

const encoder = new TextEncoder()
const frame = (delta, finish = null) =>
  "data: " +
  JSON.stringify({ id: "fixture", choices: [{ delta, finish_reason: finish }], usage: null }) +
  "\n\n"
const complete =
  frame({ role: "assistant", content: "HTTP fixture answer" }) +
  frame({}, "stop") +
  "data: [DONE]\n\n"
export function httpModel(self) {
  const deadline = self.read("config").deadlineMs ?? 300000
  const mode = self.read("config").httpMode
  const http = HttpClient.make((request) =>
    Effect.suspend(() => {
      const call = self.read("modelCalls", 0) + 1
      self.put("modelCalls", call)
      self.trace("http-start", { call, mode })
      const respond = (body, init = { headers: { "content-type": "text/event-stream" } }) =>
        HttpClientResponse.fromWeb(request, new Response(body, init))
      if (mode === "before-first" && call === 1) return Effect.never
      if (mode === "retry-after" && call === 1)
        return Effect.succeed(respond("busy", { status: 503, headers: { "retry-after": "1" } }))
      if ((mode === "midstream" && call === 1) || mode === "always-stall") {
        let sent = false
        return Effect.succeed(
          respond(
            new ReadableStream({
              pull(controller) {
                if (!sent) {
                  sent = true
                  controller.enqueue(
                    encoder.encode(frame({ role: "assistant", content: "partial" })),
                  )
                  return
                }
                return new Promise(() => {})
              },
              cancel() {
                self.trace("http-cancel", { call })
              },
            }),
          ),
        )
      }
      if (mode === "disconnect" && call === 1) {
        let sent = false
        return Effect.succeed(
          respond(
            new ReadableStream({
              pull(controller) {
                if (!sent) {
                  sent = true
                  controller.enqueue(
                    encoder.encode(frame({ role: "assistant", content: "partial" })),
                  )
                  return
                }
                controller.error(new Error("fixture socket reset"))
              },
            }),
          ),
        )
      }
      if (mode === "quiet-tool" && call === 1)
        return Effect.succeed(
          respond(
            frame({
              role: "assistant",
              tool_calls: [
                { index: 0, id: "quiet", function: { name: "fixture_pause", arguments: "{}" } },
              ],
            }) +
              frame({}, "tool_calls") +
              "data: [DONE]\n\n",
          ),
        )
      if (mode === "activity") {
        let n = 0
        return Effect.succeed(
          respond(
            new ReadableStream({
              async pull(controller) {
                await new Promise((r) => setTimeout(r, Math.floor(deadline / 3)))
                n++
                if (n <= 6) controller.enqueue(encoder.encode(frame({ content: "chunk" })))
                else {
                  controller.enqueue(encoder.encode(frame({}, "stop") + "data: [DONE]\n\n"))
                  controller.close()
                }
              },
            }),
          ),
        )
      }
      return Effect.succeed(respond(complete))
    }).pipe(
      Effect.timeout(deadline),
      Effect.map((response) =>
        Object.create(response, {
          stream: { value: response.stream.pipe(Stream.timeout(deadline)) },
        }),
      ),
    ),
  )
  const executor = RequestExecutor.layer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
  )
  return LLMClient.layer.pipe(Layer.provide(executor))
}
