import { Context, Effect, Layer, Redacted } from "effect"
import { ProtocolError } from "../Protocol.ts"
import type { CredentialPermission, RepositoryCredential } from "../Publication.ts"
import type { RepositorySelection } from "../RepositoryWorkspace.ts"

export interface RepositoryAuthorization extends RepositorySelection {
  readonly token: boolean
  readonly permission: CredentialPermission
  readonly refresh: boolean
  readonly publication: boolean
}
export interface RepositoryAuthorityBinding {
  readonly fetch: (request: Request) => Promise<Response>
}

/** Janitor remains the authority for repository readiness and scoped Git credentials. */
export class RepositoryAuthority extends Context.Service<
  RepositoryAuthority,
  {
    readonly authorize: (
      request: RepositoryAuthorization,
    ) => Effect.Effect<RepositoryCredential, ProtocolError>
  }
>()("janitor/runner/RepositoryAuthority") {
  static make(
    binding: RepositoryAuthorityBinding | undefined,
    token: string | undefined,
  ): RepositoryAuthority["Service"] {
    const secret = Redacted.make(token ?? "")
    return {
      authorize: Effect.fn("RepositoryAuthority.authorize")(function* (input) {
        if (!binding || !Redacted.value(secret))
          return yield* Effect.fail(
            new ProtocolError("blocked", "Repository credential authority is not configured"),
          )
        return yield* Effect.tryPromise({
          try: async (signal) => {
            const response = await binding.fetch(
              new Request("https://janitor/api/v1/agent/repository", {
                method: "POST",
                headers: {
                  authorization: `Bearer ${Redacted.value(secret)}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify(input),
                signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
              }),
            )
            if (!response.ok) {
              let reason = "Selected repository is not ready or credentials are unavailable"
              const body: unknown = await response.json().catch(() => null)
              if (
                body &&
                typeof body === "object" &&
                "message" in body &&
                typeof body.message === "string" &&
                body.message !== ""
              )
                reason = body.message
              throw new ProtocolError("blocked", reason, reason)
            }
            return (await response.json()) as RepositoryCredential
          },
          catch: (cause) =>
            cause instanceof ProtocolError
              ? cause
              : new ProtocolError("transport", "Repository credential authority is unavailable"),
        })
      }),
    }
  }
  static layer(binding: RepositoryAuthorityBinding | undefined, token: string | undefined) {
    return Layer.succeed(this, this.make(binding, token))
  }
}
