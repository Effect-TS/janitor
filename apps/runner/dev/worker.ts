// The local development entry: the production runner with a controlled model
// and the container's fixture remote in place of GitHub. Set
// JANITOR_LOCAL_LIVE_MODEL=true with a configured provider credential to send
// real model requests.
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { SessionRunner as ProductionRunner, type RunnerEnv } from "../src/SessionRunner.ts"
import { handle, type WorkerEnv } from "../src/worker.ts"

/** The scripted model: read the README, write a validation file, then answer. */
const scriptedTransport = () =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      const body =
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : { messages: [] }
      const messages = body.messages as Array<{ role: string; content: unknown }>
      const lastUser = messages.findLastIndex((message) => message.role === "user")
      const calls = messages.slice(lastUser + 1).filter((message) => message.role === "tool").length
      const restoring = JSON.stringify(messages[lastUser]?.content).includes("restore")
      const call =
        calls === 0
          ? {
              name: "bash",
              input: { command: restoring ? "cat local-validation.txt" : "cat README.md" },
            }
          : calls === 1 && !restoring
            ? {
                name: "write",
                input: {
                  path: "local-validation.txt",
                  content: "Local recovery point survived: apricot-47\n",
                },
              }
            : undefined
      const delta = call
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `local_${calls}`,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.input) },
              },
            ],
          }
        : {
            role: "assistant",
            content: restoring
              ? "Local recovery point survived: apricot-47."
              : "Local workspace validation completed: apricot-47.",
          }
      const frame = (delta: unknown, finish_reason: string | null, usage?: unknown) =>
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }], usage })}\n\n`
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          frame(delta, null) +
            frame({}, call ? "tool_calls" : "stop", {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            }) +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        ),
      )
    }),
  )

export class SessionRunner extends ProductionRunner {
  protected override modelTransport() {
    if (this.env.JANITOR_LOCAL_LIVE_MODEL === "true") return super.modelTransport()
    return scriptedTransport()
  }
  override async fetch(request: Request) {
    const url = new URL(request.url)
    // Destroys the container so the next turn must restore the recovery point.
    if (url.pathname.endsWith("/local-restart") && request.method === "POST") {
      await this.destroy()
      return Response.json({ restarted: true })
    }
    return super.fetch(request)
  }
}

const authority = {
  fetch: async (request: Request) => {
    const body = (await request.json()) as { permission: string }
    return body.permission !== "read"
      ? Response.json({ message: "Local publication is disabled" }, { status: 403 })
      : Response.json({ owner: "local", repo: "fixture", token: "local-fixture" })
  },
}

export default {
  fetch: (request: Request, env: WorkerEnv) =>
    handle(request, {
      ...env,
      REPOSITORY_SERVICE_TOKEN: env.REPOSITORY_SERVICE_TOKEN ?? "local-fixture",
      REPOSITORY_AUTHORITY: env.REPOSITORY_AUTHORITY ?? authority,
    } satisfies RunnerEnv as WorkerEnv),
} satisfies ExportedHandler<WorkerEnv>
