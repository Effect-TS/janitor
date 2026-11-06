import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as FetchHttpClient from "effect/http/FetchHttpClient"

/** The current test's fakes, while `fetchClient`'s scope is open. */
let active: { readonly fetch: typeof globalThis.fetch; readonly escaped: Array<string> } | undefined

/**
 * `globalThis.fetch` in tests that use `fetchClient`: one function for every
 * test, since `FetchHttpClient` keeps the first `globalThis.fetch` it reads
 * as its default. It records the request and hands it to the current test's
 * fakes, so it never reaches the network.
 */
const guard: typeof globalThis.fetch = (input, init) => {
  if (active === undefined) return Promise.reject(new TypeError("No network in tests"))
  active.escaped.push(new Request(input, init).url)
  return active.fetch(input, init)
}

/**
 * `fetch` on fake servers, `answer`, following a redirect as `fetch` does by
 * default, a 307's or 308's method and body included, unless the request
 * asked for `redirect: "manual"`.
 */
const following = (answer: (request: Request) => Promise<Response>): typeof globalThis.fetch => {
  const send = (request: Request): Effect.Effect<Response> =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() => answer(request.clone()))
      const location = response.headers.get("location")
      if (
        request.redirect === "manual" ||
        location === null ||
        response.status < 300 ||
        response.status >= 400
      )
        return response
      if (request.redirect === "error") return yield* Effect.die(new TypeError("Redirect refused"))
      const keepsMethod = response.status === 307 || response.status === 308
      const body =
        keepsMethod && request.body !== null
          ? yield* Effect.promise(() => request.text())
          : undefined
      return yield* send(
        new Request(new URL(location, request.url), {
          method: keepsMethod ? request.method : "GET",
          headers: request.headers,
          redirect: request.redirect,
          ...(body === undefined ? {} : { body }),
        }),
      )
    })
  const fetch: typeof globalThis.fetch = (input, init) =>
    Effect.runPromise(send(new Request(input, init)))
  return fetch
}

/**
 * The Worker's real `FetchHttpClient` over fake servers, `answer`
 * (EFF-3443), with `fetch`'s redirects. Every value is synthetic.
 */
export const fetchClient = (answer: (request: Request) => Promise<Response>) =>
  Effect.gen(function* () {
    const fetch = following(answer)
    /**
     * Requests sent through `globalThis.fetch` rather than the `fetch` the
     * client was given. They still reach the fakes, never the network.
     */
    const escaped: Array<string> = []
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const original = globalThis.fetch
        globalThis.fetch = guard
        active = { fetch, escaped }
        return original
      }),
      (original) =>
        Effect.sync(() => {
          active = undefined
          globalThis.fetch = original
        }),
    )
    return {
      layer: Layer.merge(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, fetch)),
      escaped,
    }
  })
