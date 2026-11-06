import * as Cloudflare from "@alchemy.run/cloudflare"
import { McpOAuthRefused, McpOAuthUnavailable } from "@janitor/domain/Chat/McpServer"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/http/HttpClient"
import { promise } from "../PullRequestReview/Sandbox/Container.ts"
import { type McpCredential, makeMcpCredential, McpUnavailable } from "./McpCredential.ts"
import type { McpCredentialShape, Server } from "./McpCredentialClient.ts"

/**
 * An MCP server's credential's Durable Object (EFF-3443): one per server
 * configured on the dashboard, named by the server's id, so its refreshes
 * happen one at a time across sessions and isolates. The class is always
 * declared, like the chat pool's, so it never takes a migration that deletes
 * its storage.
 *
 * Tokens cross the RPC boundary as plain strings: `Redacted` keeps its value
 * out of the object, so it wouldn't survive serialisation. Both sides wrap
 * them again at once. Each call names the server's URL, which is fixed once
 * the server is created.
 */

export class McpCredentialObject extends Cloudflare.DurableObject<
  McpCredentialObject,
  McpCredentialShape
>()("McpCredential", { errors: [McpUnavailable, McpOAuthUnavailable, McpOAuthRefused] }) {}

/** The part of the Durable Object's storage the credential uses. */
interface CredentialStorage {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
}

const STORAGE_KEY = "credential"

export const McpCredentialLive = McpCredentialObject.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState
    const http = yield* HttpClient.HttpClient

    return Effect.sync(() => {
      const storage = state.raw.storage as unknown as CredentialStorage
      let current: { readonly url: string; readonly credential: McpCredential } | undefined

      /** The credential for `url`, made on the first call. */
      const credentialFor = ({ url }: Server) =>
        current !== undefined && current.url === url
          ? Effect.succeed(current.credential)
          : makeMcpCredential({
              url,
              storage: {
                load: promise(() => storage.get<unknown>(STORAGE_KEY)),
                save: (value) => promise(() => storage.put(STORAGE_KEY, value)),
                clear: promise(() => storage.delete(STORAGE_KEY)),
              },
            }).pipe(
              Effect.provideService(HttpClient.HttpClient, http),
              Effect.tap((credential) =>
                Effect.sync(() => {
                  current = { url, credential }
                }),
              ),
            )

      return {
        token: (input: Server & { readonly rejected: string | null }) =>
          Effect.flatMap(credentialFor(input), (credential) =>
            credential.token(input.rejected === null ? undefined : Redacted.make(input.rejected)),
          ).pipe(Effect.map(Redacted.value)),
        status: (input: Server) =>
          Effect.flatMap(credentialFor(input), (credential) => credential.status),
        setBearer: (input: Server & { readonly token: string }) =>
          Effect.flatMap(credentialFor(input), (credential) =>
            credential.setBearer(Redacted.make(input.token)),
          ),
        startOAuth: (input: Server & { readonly redirectUri: string }) =>
          Effect.flatMap(credentialFor(input), (credential) =>
            credential.startOAuth({ redirectUri: input.redirectUri }),
          ),
        finishOAuth: (input: Server & { readonly code: string; readonly state: string }) =>
          Effect.flatMap(credentialFor(input), (credential) =>
            credential.finishOAuth({ code: input.code, state: input.state }),
          ),
        wipe: (input: Server) =>
          Effect.flatMap(credentialFor(input), (credential) => credential.wipe),
      }
    })
  }),
)
