import {
  McpOAuthRefused,
  McpOAuthUnavailable,
  type McpServerStatus,
} from "@janitor/domain/Chat/McpServer"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { type McpCredential, McpCredentials, McpUnavailable } from "./McpCredential.ts"

/**
 * The Worker's side of each MCP server's credential object
 * (`McpCredentialObject.ts`): its RPC shape and `McpCredentials` over it.
 * Kept apart from the object, like `WorkspaceClient.ts`, so callers don't
 * import the object's runtime.
 */

export interface Server {
  readonly url: string
}

export interface McpCredentialShape {
  /** `rejected` is the token the server answered 401 to, if any; see `McpCredential.token`. */
  readonly token: (
    input: Server & { readonly rejected: string | null },
  ) => Effect.Effect<string, McpUnavailable>
  readonly status: (input: Server) => Effect.Effect<McpServerStatus>
  readonly setBearer: (input: Server & { readonly token: string }) => Effect.Effect<void>
  readonly startOAuth: (
    input: Server & { readonly redirectUri: string },
  ) => Effect.Effect<string, McpOAuthUnavailable>
  readonly finishOAuth: (
    input: Server & { readonly code: string; readonly state: string },
  ) => Effect.Effect<void, McpOAuthRefused>
  readonly wipe: (input: Server) => Effect.Effect<void>
}

/**
 * The failure a call can expect, or `fallback` for any other: a failed RPC,
 * a reset object or a deploy in progress. Interruptions pass through.
 */
const expecting =
  <E>(is: (error: unknown) => error is E, fallback: Effect.Effect<never, E>) =>
  <A>(self: Effect.Effect<A, unknown>): Effect.Effect<A, E> =>
    Effect.catchCause(self, (cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>)
      const error = Cause.findErrorOption(cause)
      return Option.isSome(error) && is(error.value)
        ? Effect.fail(error.value)
        : Effect.logWarning("Couldn't reach an MCP server's credential").pipe(
            Effect.andThen(fallback),
          )
    })

const isUnavailable = Schema.is(McpUnavailable)
const isOAuthUnavailable = Schema.is(McpOAuthUnavailable)
const isRefused = Schema.is(McpOAuthRefused)

/** The Worker's side: each server's credential over its object's RPC. */
export const mcpCredentialsFrom = (objects: {
  readonly getByName: (name: string) => McpCredentialShape
}): Layer.Layer<McpCredentials> =>
  Layer.succeed(
    McpCredentials,
    McpCredentials.of({
      forServer: (server) =>
        Effect.sync((): McpCredential => {
          const object = () => objects.getByName(server.id)
          const url = server.url
          return {
            token: (rejected) =>
              Effect.suspend(() =>
                object().token({
                  url,
                  rejected: rejected === undefined ? null : Redacted.value(rejected),
                }),
              ).pipe(
                expecting(isUnavailable, Effect.fail(new McpUnavailable())),
                Effect.map((token) => Redacted.make(token)),
              ),
            status: Effect.suspend(() => object().status({ url })).pipe(
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterruptsOnly(cause),
                () => Effect.succeed<McpServerStatus>("unavailable"),
              ),
            ),
            setBearer: (token) =>
              Effect.suspend(() => object().setBearer({ url, token: Redacted.value(token) })).pipe(
                Effect.orDie,
              ),
            startOAuth: ({ redirectUri }) =>
              Effect.suspend(() => object().startOAuth({ url, redirectUri })).pipe(
                expecting(isOAuthUnavailable, Effect.fail(new McpOAuthUnavailable())),
              ),
            finishOAuth: ({ code, state }) =>
              Effect.suspend(() => object().finishOAuth({ url, code, state })).pipe(
                expecting(isRefused, Effect.fail(new McpOAuthRefused())),
              ),
            wipe: Effect.suspend(() => object().wipe({ url })).pipe(Effect.orDie),
          }
        }),
    }),
  )
