import { timed } from "./Telemetry.ts"
import { Context, Effect, Layer } from "effect"
import { ProtocolError } from "../Protocol.ts"
import type { Binding, WorkspaceSandbox } from "../RepositoryWorkspace.ts"
import type { Archive } from "../WorkspaceCheckpoints.ts"

const diagnostics = new Set([
  "stale generation",
  "stale epoch; reconcile before retry",
  "clone outcome requires reconciliation",
  "repository destination exists",
  "repository clone failed",
  "preparation outcome requires reconciliation",
  "publication active",
  "processes active",
])

/** Sandbox SDK lifecycle and the authenticated bridge transport. Mutations are never retried here. */
export class SandboxBridge extends Context.Service<
  SandboxBridge,
  {
    readonly start: (binding: Binding) => Effect.Effect<void, ProtocolError>
    readonly running: (binding: Binding) => Effect.Effect<boolean, ProtocolError>
    readonly destroy: (binding: Binding) => Effect.Effect<void, ProtocolError>
    readonly request: (
      binding: Binding,
      path: string,
      input?: unknown,
      archive?: Archive,
    ) => Effect.Effect<Response, ProtocolError>
  }
>()("janitor/runner/SandboxBridge") {
  static make(resolve: (binding: Binding) => WorkspaceSandbox): SandboxBridge["Service"] {
    const attempt = <A>(operation: string, run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (cause) =>
          cause instanceof ProtocolError
            ? cause
            : new ProtocolError("transport", `Sandbox ${operation} failed`),
      })
    return {
      start: Effect.fn("SandboxBridge.start")(function* (binding) {
        yield* attempt("startup", async () => {
          const sandbox = resolve(binding)
          const process =
            (await sandbox.getProcess?.("janitor-bridge")) ??
            (await sandbox.startProcess("node /opt/janitor/entry.mjs", {
              processId: "janitor-bridge",
              env: {
                JANITOR_BRIDGE_TOKEN: binding.token,
                JANITOR_GENERATION: String(binding.selected.generation),
              },
            }))
          await process.waitForPort(8788, { mode: "tcp" })
        }).pipe(
          timed("sandbox.ready", {
            sessionId: binding.selected.sessionId,
            generation: binding.selected.generation,
          }),
        )
      }),
      running: Effect.fn("SandboxBridge.running")((binding) =>
        attempt("inspection", async () =>
          Boolean(await resolve(binding).getProcess?.("janitor-bridge")),
        ),
      ),
      destroy: Effect.fn("SandboxBridge.destroy")((binding) =>
        attempt("destruction", async () => {
          await resolve(binding).destroy()
        }),
      ),
      request: Effect.fn("SandboxBridge.request")(function* (binding, path, input, archive) {
        const method = input === undefined && !archive ? "GET" : "POST"
        const response = yield* attempt("transport", () =>
          resolve(binding).containerFetch(
            `http://bridge${path}`,
            {
              method,
              headers: {
                authorization: `Bearer ${binding.token}`,
                "x-janitor-generation": String(binding.selected.generation),
                "x-bridge-epoch": binding.epoch ?? "",
                ...(archive
                  ? {
                      "content-type": "application/x-ndjson",
                      "x-archive-sha256": archive.sha256,
                      "content-length": String(archive.size),
                    }
                  : { "content-type": "application/json" }),
              },
              body: archive?.body ?? (input === undefined ? undefined : JSON.stringify(input)),
            },
            8788,
          ),
        )
        if (!response.ok) {
          const body: unknown = yield* Effect.promise(() => response.json().catch(() => null))
          const reason =
            body &&
            typeof body === "object" &&
            "error" in body &&
            typeof body.error === "string" &&
            diagnostics.has(body.error)
              ? `: ${body.error}`
              : ""
          return yield* Effect.fail(
            new ProtocolError(
              response.status >= 500 ? "transport" : "blocked",
              `Bridge refused ${method} ${path} (${response.status})${reason}`,
            ),
          )
        }
        return response
      }),
    }
  }
  static layer(resolve: (binding: Binding) => WorkspaceSandbox) {
    return Layer.succeed(this, this.make(resolve))
  }
}
