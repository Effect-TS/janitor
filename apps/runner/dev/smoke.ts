import { Config, Data, Effect, Schedule } from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

class LocalRunnerUnavailable extends Data.TaggedError("LocalRunnerUnavailable")<{
  readonly message: string
}> {}

const program = Effect.gen(function* () {
  const base = yield* Config.String("JANITOR_LOCAL_RUNNER_URL").pipe(
    Config.withDefault("http://127.0.0.1:8790"),
  )
  const url = new URL(base)
  if (!["127.0.0.1", "localhost"].includes(url.hostname))
    return yield* Effect.die(new Error("Local smoke only accepts a loopback runner URL"))
  const token = yield* Config.String("JANITOR_AGENT_RUNNER_TOKEN").pipe(
    Config.withDefault("janitor-local-runner"),
  )
  const api = yield* Config.String("JANITOR_API_ORIGIN").pipe(
    Config.withDefault("http://localhost:8787"),
  )
  if (!["127.0.0.1", "localhost"].includes(new URL(api).hostname))
    return yield* Effect.die(new Error("Local smoke only accepts a loopback API URL"))
  const readiness = yield* Effect.tryPromise(() =>
    fetch(api + "/api/v1/ready", { signal: AbortSignal.timeout(10000) }),
  )
  if (!readiness.ok) return yield* Effect.die(new Error("Local API is not ready"))
  const maintenanceToken = yield* Config.String("JANITOR_MAINTENANCE_TOKEN").pipe(
    Config.withDefault(""),
  )
  if (maintenanceToken) {
    const maintenance = (path: string, body?: unknown) =>
      Effect.tryPromise({
        try: async () => {
          const response = await fetch(api + "/api/v1/maintenance" + path, {
            method: body === undefined ? "GET" : "POST",
            headers: {
              authorization: "Bearer " + maintenanceToken,
              "content-type": "application/json",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(30000),
          })
          if (!response.ok) throw new Error("Local maintenance request failed: " + response.status)
          return (await response.json()) as {
            epoch: number
            state: string
            verifiedRelease?: string
          } | null
        },
        catch: (cause) => cause,
      })
    const previous = yield* maintenance("")
    if (previous && previous.state !== "released")
      return yield* Effect.die(new Error("Local maintenance is already active"))
    const held = yield* maintenance("/hold", { reason: "Local Alchemy integration validation" })
    const released = yield* maintenance("/release", { epoch: held!.epoch })
    if (released?.state !== "released" || !released.verifiedRelease)
      return yield* Effect.die(
        new Error("API did not verify the runner release through its service binding"),
      )
  }
  const id = `local_${crypto.randomUUID().replaceAll("-", "")}`
  const call = (method: string, path: string, body?: unknown) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${base}/v1/sessions/${id}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "x-janitor-runner-protocol": "2",
            "content-type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        })
        if ([502, 503, 504].includes(response.status)) {
          await response.body?.cancel()
          throw new LocalRunnerUnavailable({
            message: `${method} ${path}: local runner unavailable (${response.status})`,
          })
        }
        if (!response.ok)
          throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
        return (await response.json()) as {
          execution?: string
          lastOutcome?: string
          events?: Array<{ type: string; data: unknown }>
        }
      },
      catch: (cause) =>
        cause instanceof TypeError
          ? new LocalRunnerUnavailable({ message: "Local runner connection lost" })
          : cause,
    }).pipe(
      // These commands retain the same generation/input identity after a lost proxy response.
      // The local container-destruction endpoint is deliberately excluded from automatic replay.
      Effect.retry({
        times: 4,
        schedule: Schedule.spaced("500 millis"),
        while: (error) => path !== "/local-restart" && error instanceof LocalRunnerUnavailable,
      }),
    )
  const idle = Effect.gen(function* () {
    for (let attempt = 0; attempt < 180; attempt++) {
      const state = yield* call("GET", "")
      if (state.execution === "failed")
        return yield* Effect.die(new Error("Local model turn failed"))
      if (state.execution === "idle" && state.lastOutcome === "succeeded") return
      yield* Effect.sleep("1 second")
    }
    return yield* Effect.die(new Error("Timed out waiting for local runner"))
  })
  yield* call("PUT", "", {
    generation: 1,
    repositoryId: "123",
    title: "Local Alchemy runner validation",
  })
  const admit = (name: string, text: string) =>
    call("POST", "/inputs", {
      generation: 1,
      inputId: `msg_${name}`,
      text,
      attribution: { source: "driver" },
    })
  yield* Effect.gen(function* () {
    yield* admit("initial", "Validate the disposable local repository.")
    yield* idle
    yield* call("POST", "/local-restart", {})
    yield* admit("restored", "Validate restore by reading local-validation.txt.")
    yield* idle
    const events = yield* call("GET", "/events?after=0&limit=500")
    if (
      !events.events?.some(
        (event) =>
          event.type === "session.tool.success" &&
          JSON.stringify(event.data).includes("Local checkpoint survived"),
      )
    )
      return yield* Effect.die(
        new Error("Restored workspace content was not observed in native tool results"),
      )
  }).pipe(Effect.ensuring(call("DELETE", "", { generation: 1 }).pipe(Effect.orDie)))
  yield* Effect.logInfo(
    "Passed: GitHub fixture, native model tools, SQLite file edit, host replacement, retained files and cleanup",
  )
})
NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
