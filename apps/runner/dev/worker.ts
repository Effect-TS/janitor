import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { getSandbox } from "@cloudflare/sandbox"
import { SessionRunner as NativeRunner, type RunnerEnv } from "../src/SessionRunner.ts"
import { SessionController } from "../src/SessionController.ts"
import {
  RepositoryWorkspace,
  type Binding,
  type RepositorySelection,
} from "../src/RepositoryWorkspace.ts"
import { handle, type WorkerEnv } from "../src/worker.ts"
export { Sandbox } from "@cloudflare/sandbox"

class LocalSession extends SessionController {
  protected override options() {
    return { ...super.options(), intervalMs: 1000 }
  }
  protected override makeRepository(selected: RepositorySelection) {
    if (selected.repositoryId !== "123")
      throw new Error("Local development only supports repositoryId 123")
    return new (class extends RepositoryWorkspace {
      protected override sandbox(binding: Binding) {
        const sandbox = super.sandbox(binding)
        return {
          getProcess: (id: string) => sandbox.getProcess?.(id) ?? Promise.resolve(null),
          startProcess: (
            _command: string,
            options: { processId: string; env: Record<string, string> },
          ) => sandbox.startProcess("node /opt/janitor/dev-bridge.mjs", options),
          containerFetch: (url: string, init: RequestInit, port: number) =>
            sandbox.containerFetch(url, init, port),
          destroy: () => sandbox.destroy(),
        }
      }
    })(
      this.ctx.storage,
      {
        ...this.env,
        REPOSITORY_SERVICE_TOKEN: "local-fixture",
        REPOSITORY_AUTHORITY: {
          fetch: async (request) => {
            const body = (await request.json()) as { permission: string }
            return body.permission !== "read"
              ? Response.json({ message: "Local publication is disabled" }, { status: 403 })
              : Response.json({ owner: "local", repo: "fixture", token: "local-fixture" })
          },
        },
      },
      selected,
    )
  }
  protected override transport() {
    // Explicit opt-in keeps ordinary local development free of provider calls.
    if (this.env.JANITOR_LOCAL_LIVE_MODEL === "true") return super.transport()
    return HttpClient.make((request) =>
      Effect.sync(() => {
        const body =
          request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : { messages: [] }
        const messages = body.messages as Array<{ role: string; content: unknown }>
        const lastUser = messages.findLastIndex((message) => message.role === "user")
        const calls = messages
          .slice(lastUser + 1)
          .filter((message) => message.role === "tool").length
        const restoring = JSON.stringify(messages[lastUser]?.content).includes("restore")
        const call =
          calls === 0
            ? { name: "read", input: { path: restoring ? "local-validation.txt" : "README.md" } }
            : calls === 1 && !restoring
              ? {
                  name: "write",
                  input: {
                    path: "local-validation.txt",
                    content: "Local checkpoint survived: apricot-47\n",
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
          : { role: "assistant", content: "Local workspace validation completed: apricot-47." }
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
  }
  override async fetch(request: Request) {
    if (new URL(request.url).pathname.endsWith("/local-restart") && request.method === "POST") {
      const binding = await this.ctx.storage.get<Binding>("_janitor_workspace")
      if (!binding || !this.env.SANDBOXES)
        return new Response("No local workspace", { status: 404 })
      await this.disposeHost()
      await getSandbox(this.env.SANDBOXES, binding.resource).destroy()
      return Response.json({ restarted: true })
    }
    return super.fetch(request)
  }
}
export class SessionRunner extends NativeRunner {
  protected override makeController(ctx: DurableObjectState, env: RunnerEnv) {
    return new LocalSession(ctx, env)
  }
}
export default {
  fetch: handle,
} satisfies ExportedHandler<WorkerEnv>
