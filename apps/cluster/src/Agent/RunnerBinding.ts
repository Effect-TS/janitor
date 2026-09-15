import * as Binding from "alchemy/Binding"
import { WorkerEnvironment, isWorker } from "alchemy/Cloudflare/Workers"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

/** Stable physical name: both directions bind by name to avoid a resource cycle. */
export const runnerWorkerName = "janitor-agent-runner"

export const runnerTransport = Effect.gen(function* () {
  if (!globalThis.__ALCHEMY_RUNTIME__) {
    const host = yield* Binding.Host
    if (host !== undefined && isWorker(host)) {
      yield* host.bind`runner-service`({
        bindings: [{ type: "service", name: "AGENT_RUNNER", service: runnerWorkerName }],
      })
    }
  }
  const env = yield* WorkerEnvironment
  return FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch, (input, init) => {
        const binding = (env as { AGENT_RUNNER?: { fetch: typeof fetch } }).AGENT_RUNNER
        if (binding === undefined)
          return Promise.reject(new Error("Runner service binding is missing"))
        return binding.fetch(input, init)
      }),
    ),
  )
})
