import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import type { McpCredential } from "./McpCredential.ts"

/**
 * A `fetch` over an Effect `HttpClient`, for the MCP SDK (EFF-3443): its
 * streamable HTTP transport in turns, and its OAuth helpers in **Connect**
 * and refresh. Every MCP request goes through the client the Worker gives.
 */

/** Thrown when there's no token: the MCP request fails, unsent. */
const UNAVAILABLE = "The MCP server's credential is unavailable"

/**
 * Sends each request through `http`, with `credential`'s current token when
 * one is given.
 *
 * A request with a signal, as the transport's are, keeps its response open
 * until the signal aborts, which the transport does on close, so an open
 * event stream ends with the turn. A request without one, as the OAuth
 * helpers' are, gets its body read at once and its connection released.
 *
 * A 401 reports the token rejected, so the next request gets a new one, and
 * is handed back as it is: the request is never sent again, so no write
 * reaches the server twice. The SDK fails that request, and a `tools/call`
 * becomes a tool error the model sees.
 */
export const fetchVia =
  (
    http: HttpClient.HttpClient,
    /**
     * The services the caller was built with, which each request runs with:
     * a `FetchHttpClient`'s `Fetch` and `RequestInit` among them.
     */
    services: Context.Context<never>,
    options: {
      /** Sends each request with this credential's current token. */
      readonly credential?: McpCredential | undefined
      /**
       * Hands a failed response back with no body. The SDK puts an error
       * body in its exception, which reaches the logs and the model, and a
       * server can echo the request there, token included. The OAuth helpers
       * need the body to read the OAuth error code, so it's the transport's.
       */
      readonly withoutErrorBodies?: boolean | undefined
    } = {},
  ): typeof globalThis.fetch =>
  (input, init) => {
    const request = new Request(input, init)
    const { credential, withoutErrorBodies = false } = options
    const streaming = init?.signal != null
    const scope = Scope.makeUnsafe()
    const release = () => Effect.runFork(Scope.close(scope, Exit.void))
    if (streaming) {
      if (request.signal.aborted) release()
      else request.signal.addEventListener("abort", release, { once: true })
    }
    // The SDK asks for `redirect: "manual"` so it can follow a redirect only
    // within the request's origin and refuse the rest, https to http
    // included. `fetch` would otherwise follow any redirect itself, re-sending
    // the body (a code, verifier, refresh token or tool call) wherever it led.
    // The SDK asks for `redirect: "manual"` so it can follow a redirect only
    // within the request's origin and refuse the rest, https to http
    // included. `fetch` would otherwise follow any redirect itself, re-sending
    // the body (a code, verifier, refresh token or tool call) wherever it led.
    const requestInit = {
      ...Context.getOrUndefined(services, FetchHttpClient.RequestInit),
      redirect: request.redirect,
    }
    return Effect.runPromiseWith(services)(
      Effect.gen(function* () {
        const token =
          credential === undefined
            ? undefined
            : yield* credential
                .token()
                .pipe(Effect.catchTag("McpUnavailable", () => Effect.die(new Error(UNAVAILABLE))))
        const body =
          request.body === null ? undefined : yield* Effect.tryPromise(() => request.text())
        const outgoing = HttpClientRequest.make(request.method as "GET")(request.url, {
          headers: request.headers,
        }).pipe(
          token === undefined ? (self) => self : HttpClientRequest.bearerToken(token),
          body === undefined
            ? (self) => self
            : HttpClientRequest.bodyText(body, request.headers.get("content-type") ?? undefined),
        )
        const response = yield* HttpClient.withScope(http)
          .execute(outgoing)
          .pipe(Scope.provide(scope))
        if (response.status === 401 && credential !== undefined && token !== undefined)
          yield* Effect.ignore(credential.token(token))
        const init = {
          status: response.status,
          headers: response.headers as Record<string, string>,
        }
        const empty =
          response.status === 204 ||
          response.status === 304 ||
          (withoutErrorBodies && (response.status < 200 || response.status >= 300))
        if (empty) return new Response(null, init)
        if (!streaming) return new Response(yield* response.arrayBuffer, init)
        return Option.getOrElse(
          HttpClientResponse.toWeb(response),
          () => new Response(Stream.toReadableStream(response.stream), init),
        )
      }).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, requestInit),
        streaming ? (self) => self : Effect.ensuring(Scope.close(scope, Exit.void)),
      ),
      streaming ? { signal: request.signal } : undefined,
    )
  }
