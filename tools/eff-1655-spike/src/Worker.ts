import * as Cloudflare from "alchemy/Cloudflare"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import AgentObjectLive, { AgentObject, type Transport } from "./AgentObject.ts"

/**
 * Thin HTTP front door for the spike. Every route takes `?name=` (DO name)
 * and `?transport=http|ws`.
 */
export default class SpikeWorker extends Cloudflare.Worker<SpikeWorker>()(
  "Eff1655SpikeWorker",
  {
    main: import.meta.url,
    // janitor production uses 2026-09-05; the local workerd here is 2026-09-18.
    compatibility: { date: "2026-09-05", flags: ["nodejs_compat"] },
    workersDev: false,
    dev: { port: 8955, strictPort: true },
  },
  Effect.gen(function* () {
    const agents = yield* AgentObject.pipe(Effect.provide(AgentObjectLive))
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        const name = url.searchParams.get("name") ?? "default"
        const transport = (url.searchParams.get("transport") ?? "http") as Transport
        const agent = agents.getByName(name)
        const json = (value: unknown) => HttpServerResponse.jsonUnsafe(value)
        switch (url.pathname) {
          case "/health":
            return json(yield* agent.health())
          case "/abort":
            return json(
              yield* agent.abort().pipe(Effect.catchCause((cause) => Effect.succeed({ abortCallFailed: Cause.pretty(cause).slice(0, 400) }))),
            )
          case "/rawrpc":
            return json(yield* agent.rawRpc(url.searchParams.get("mode") ?? "string"))
          case "/caps":
            return json(yield* agent.capabilities(transport))
          case "/exec":
            return json(yield* agent.executeConcurrent(transport, Number(url.searchParams.get("n") ?? "3")))
          case "/turn":
            return json(
              yield* agent.turn(transport, [
                'console.log("step 1 in", await bash({ command: "hostname; pwd; cat AGENTS.md" }))',
                'const answer = await delegate("what is 2+2?"); console.log("step 2 delegate ->", answer)',
                'await writeFile({ path: "notes.txt", content: "hello from the loop" }); console.log("step 3", await bash({ command: "ls -la /workspace; cat /workspace/notes.txt" }))',
                'await taskComplete("spike turn complete")',
              ]),
            )
          case "/crash":
            return json(yield* agent.turnWithContainerCrash(transport))
          case "/bg/start":
            return json(yield* agent.startBackgroundTurn(transport))
          case "/bg/status":
            return json(yield* agent.backgroundStatus())
          case "/interrupt":
            return json(yield* agent.interruptExecute(transport))
          default:
            return HttpServerResponse.text(
              "routes: /health /caps /exec?n= /turn /crash /bg/start /bg/status /interrupt  (?name=&transport=http|ws)",
              { status: 404 },
            )
        }
      }),
    }
  }),
) {}
