// Local Alchemy smoke: creates a session against the local runner, runs a
// controlled turn, destroys the container, and checks that the next turn
// restores the recovery point. Opt-in; not part of the default PR checks.
import { Effect } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "../src/Protocol.ts"

const runnerUrl = process.env.JANITOR_LOCAL_RUNNER_URL ?? "http://127.0.0.1:8790"
const apiOrigin = process.env.JANITOR_API_ORIGIN ?? "http://localhost:8787"
const token = process.env.JANITOR_AGENT_RUNNER_TOKEN ?? "janitor-local-runner"
const loopback = (url: string) => /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)
if (!loopback(runnerUrl) || !loopback(apiOrigin))
  throw new Error("The local smoke only runs against loopback URLs")

const sessionId = `local_smoke_${Date.now()}`
const call = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(`${runnerUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(120_000),
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${JSON.stringify(body)}`)
  return body as Record<string, unknown>
}

const waitForTurn = async (inputId: string) => {
  for (let attempt = 0; attempt < 600; attempt++) {
    const read = (await call(`/v1/sessions/${sessionId}/events?after=0&limit=500`)) as {
      events: Array<{ type: string; data: { inputId?: string; text?: string; reason?: string } }>
    }
    const terminal = read.events.find(
      (event) =>
        event.data.inputId === inputId &&
        ["turn.completed", "turn.interrupted", "turn.save_failed"].includes(event.type),
    )
    if (terminal) return terminal
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`Turn ${inputId} did not finish`)
}

const program = Effect.gen(function* () {
  const ready = yield* Effect.promise(() => fetch(`${apiOrigin}/api/v1/ready`))
  if (!ready.ok) throw new Error("The local API is not ready")
  yield* Effect.promise(() =>
    call(`/v1/sessions/${sessionId}`, {
      method: "PUT",
      body: JSON.stringify({ generation: 1, title: "Local smoke", repositoryId: "123" }),
    }),
  )
  const first = "msg_localsmoke1"
  yield* Effect.promise(() =>
    call(`/v1/sessions/${sessionId}/inputs`, {
      method: "POST",
      body: JSON.stringify({
        generation: 1,
        inputId: first,
        text: "Read the README and write the validation file.",
        attribution: { source: "driver" },
      }),
    }),
  )
  const completed = yield* Effect.promise(() => waitForTurn(first))
  if (completed.type !== "turn.completed")
    throw new Error(`First turn ended with ${completed.type}: ${completed.data.reason}`)
  yield* Effect.promise(() => call(`/v1/sessions/${sessionId}/local-restart`, { method: "POST" }))
  const second = "msg_localsmoke2"
  yield* Effect.promise(() =>
    call(`/v1/sessions/${sessionId}/inputs`, {
      method: "POST",
      body: JSON.stringify({
        generation: 1,
        inputId: second,
        text: "After the restore, read local-validation.txt.",
        attribution: { source: "driver" },
      }),
    }),
  )
  const restored = yield* Effect.promise(() => waitForTurn(second))
  if (restored.type !== "turn.completed" || !restored.data.text?.includes("apricot-47"))
    throw new Error(`Recovery point did not survive: ${JSON.stringify(restored)}`)
  yield* Effect.log(
    "Local smoke passed: turn completed, container replaced, recovery point restored",
  )
}).pipe(
  Effect.ensuring(
    Effect.promise(() =>
      call(`/v1/sessions/${sessionId}`, {
        method: "DELETE",
        body: JSON.stringify({ generation: 1 }),
      }).catch(() => undefined),
    ),
  ),
)

NodeRuntime.runMain(program)
