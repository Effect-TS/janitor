import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"

/**
 * An MCP server's OAuth authorisation server (EFF-3443), for the dashboard's
 * **Connect**: protected resource metadata on the MCP server's host, then
 * authorisation server metadata, dynamic client registration, the
 * authorisation endpoint, which the test drives with `approve`, and the token
 * endpoint. Every value is synthetic.
 */

const decodeRegistration = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)

export const ISSUER = "https://auth.mcp.test"
export const AUTHORIZE_URL = `${ISSUER}/authorize`
export const TOKEN_URL = `${ISSUER}/token`
/** The secret a confidential client is registered with. */
export const CLIENT_SECRET = "mcp-client-secret-9b2e"

/**
 * One request the token endpoint received. The client's credentials are in
 * `params` as `client_id` and `client_secret`, wherever the client sent
 * them: in the form or as HTTP Basic.
 */
export interface TokenRequest {
  readonly url: string
  readonly method: string
  readonly contentType: string | null
  readonly params: Record<string, string>
}

export type Answer = (params: Record<string, string>) => Effect.Effect<Response, "network">

/** The endpoints authorisation server metadata names. */
export type Endpoints = Partial<
  Record<"authorization_endpoint" | "token_endpoint" | "registration_endpoint", string>
>

interface Grant {
  readonly clientId: string
  readonly redirectUri: string
  readonly challenge: string
  used: boolean
}

const base64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")

export class FakeAuthorizationServer {
  /** The bodies of the client registrations, in order. */
  readonly registrations: Array<Record<string, unknown>> = []
  readonly tokenRequests: Array<TokenRequest> = []
  /** Every request, as `METHOD url`, discovery included. */
  readonly seen: Array<string> = []
  /** Registers clients with `CLIENT_SECRET` while set; otherwise as public clients. */
  confidential = false
  /**
   * Endpoints the metadata names instead of its own, as a hostile or
   * misconfigured server's can. The server still answers on its host over
   * `http:`, so a request sent to one shows in `seen`.
   */
  endpoints: Endpoints = {}
  /** While set, the token endpoint answers 307 with this `Location`. */
  tokenRedirect: string | undefined
  /** Awaited before the token endpoint answers a code grant, so a test can hold the exchange. */
  beforeExchange: Effect.Effect<void> = Effect.void
  private issued = 0
  private readonly clients = new Map<string, ReadonlyArray<string>>()
  private readonly grants = new Map<string, Grant>()

  /** How the token endpoint answers a refresh. By default: the next access token, for an hour. */
  answerRefresh: Answer = () => Effect.succeed(this.grant({ expires_in: 3600 }))

  /** `resource` is the MCP server's URL, which its metadata names. */
  constructor(readonly resource: string) {}

  /** A successful token response with the next access token, `access-<n>`, and `fields`. */
  grant(fields: { readonly expires_in?: number; readonly refresh_token?: string }) {
    this.issued += 1
    return Response.json({ access_token: `access-${this.issued}`, token_type: "Bearer", ...fields })
  }

  /** The refresh grants the token endpoint received. */
  get refreshes() {
    return this.tokenRequests.filter((request) => request.params.grant_type === "refresh_token")
  }

  /** The authorisation code grants the token endpoint received. */
  get exchanges() {
    return this.tokenRequests.filter(
      (request) => request.params.grant_type === "authorization_code",
    )
  }

  /**
   * The user consenting at `authorizationUrl`: the code the browser is sent
   * back with, and the `state` it carried. Throws on a URL this server
   * wouldn't accept.
   */
  approve(authorizationUrl: string): { readonly code: string; readonly state: string } {
    const url = new URL(authorizationUrl)
    const param = (name: string) => {
      const value = url.searchParams.get(name)
      if (value === null) throw new Error(`The authorisation URL has no ${name}`)
      return value
    }
    if (`${url.origin}${url.pathname}` !== AUTHORIZE_URL)
      throw new Error(`Not the authorisation endpoint: ${authorizationUrl}`)
    if (param("response_type") !== "code") throw new Error("Not the code flow")
    if (param("code_challenge_method") !== "S256") throw new Error("Not PKCE with S256")
    const clientId = param("client_id")
    const redirectUri = param("redirect_uri")
    if (!this.clients.get(clientId)?.includes(redirectUri))
      throw new Error(`${redirectUri} isn't registered for ${clientId}`)
    const code = `code-${this.grants.size + 1}`
    this.grants.set(code, {
      clientId,
      redirectUri,
      challenge: param("code_challenge"),
      used: false,
    })
    return { code, state: param("state") }
  }

  /** The code grant: the code is single-use and must come with its verifier. */
  private exchange(params: Record<string, string>): Effect.Effect<Response> {
    return Effect.gen({ self: this }, function* () {
      const grant = this.grants.get(params.code ?? "")
      const digest = yield* Effect.promise(() =>
        crypto.subtle.digest("SHA-256", new TextEncoder().encode(params.code_verifier ?? "")),
      )
      if (
        grant === undefined ||
        grant.used ||
        grant.clientId !== params.client_id ||
        grant.redirectUri !== params.redirect_uri ||
        grant.challenge !== base64url(digest)
      )
        return Response.json({ error: "invalid_grant" }, { status: 400 })
      grant.used = true
      return this.grant({ expires_in: 3600, refresh_token: `refresh-${params.code}` })
    })
  }

  private register(body: Record<string, unknown>): Response {
    this.registrations.push(body)
    const clientId = `client-${this.registrations.length}`
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : []
    this.clients.set(clientId, redirectUris)
    return Response.json(
      {
        ...body,
        client_id: clientId,
        client_id_issued_at: 1_700_000_000,
        token_endpoint_auth_method: this.confidential ? "client_secret_post" : "none",
        ...(this.confidential ? { client_secret: CLIENT_SECRET } : {}),
      },
      { status: 201 },
    )
  }

  /** Every request to the MCP server's host and the authorisation server's. */
  private answer(web: Request): Effect.Effect<Response, "network"> {
    return Effect.gen({ self: this }, function* () {
      const body = yield* Effect.promise(() => web.text())
      const url = new URL(web.url)
      this.seen.push(`${web.method} ${url.href}`)
      const resource = new URL(this.resource)
      const respond = Effect.succeed<Response>

      if (
        url.origin === resource.origin &&
        url.pathname.startsWith("/.well-known/oauth-protected-resource")
      )
        return yield* respond(
          Response.json({ resource: this.resource, authorization_servers: [ISSUER] }),
        )
      if (url.host !== new URL(ISSUER).host)
        return yield* respond(new Response(null, { status: 404 }))
      if (
        url.pathname.startsWith("/.well-known/oauth-authorization-server") ||
        url.pathname.startsWith("/.well-known/openid-configuration")
      )
        return yield* respond(
          Response.json({
            issuer: ISSUER,
            authorization_endpoint: AUTHORIZE_URL,
            token_endpoint: TOKEN_URL,
            registration_endpoint: `${ISSUER}/register`,
            ...this.endpoints,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: [
              "none",
              "client_secret_post",
              "client_secret_basic",
            ],
          }),
        )
      if (url.pathname === "/register" && web.method === "POST")
        return yield* respond(this.register(decodeRegistration(body)))
      if (url.pathname !== new URL(TOKEN_URL).pathname)
        return yield* respond(new Response(null, { status: 404 }))
      if (this.tokenRedirect !== undefined && url.href === TOKEN_URL)
        return yield* respond(
          new Response(null, { status: 307, headers: { location: this.tokenRedirect } }),
        )

      const params = Object.fromEntries(new URLSearchParams(body))
      const basic = web.headers.get("authorization")?.match(/^Basic (.+)$/)?.[1]
      if (basic !== undefined) {
        const [id, secret] = atob(basic).split(":").map(decodeURIComponent)
        if (id !== undefined) params.client_id = id
        if (secret !== undefined) params.client_secret = secret
      }
      this.tokenRequests.push({
        url: web.url,
        method: web.method,
        contentType: web.headers.get("content-type"),
        params,
      })
      if (params.grant_type !== "authorization_code") return yield* this.answerRefresh(params)
      yield* this.beforeExchange
      return yield* this.exchange(params)
    })
  }

  /** The server behind an `HttpClient`. */
  get layer() {
    return Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.orDie(HttpClientRequest.toWeb(request)).pipe(
          Effect.flatMap((web) => this.answer(web)),
          Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
          Effect.mapError(
            () =>
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request }),
              }),
          ),
        ),
      ),
    )
  }

  /** The server for `fetch`, which rejects as `fetch` does when the network fails. */
  readonly fetch = (request: Request) =>
    Effect.runPromise(
      this.answer(request).pipe(
        Effect.catch(() => Effect.die(new TypeError("Network connection lost"))),
      ),
    )
}
