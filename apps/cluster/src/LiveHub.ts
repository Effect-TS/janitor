import * as Cloudflare from "alchemy/Cloudflare"
import type { DurableObjectShape } from "alchemy/Cloudflare/Workers"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"

export const LiveNotice = Schema.Struct({
  revision: Schema.String,
  topics: Schema.Array(
    Schema.Literals([
      "configuration",
      "activity",
      "sync",
      "candidates",
      "consent",
      "test",
      "repository",
    ]),
  ),
  disconnected: Schema.Boolean,
})
const Attachment = Schema.Struct({ expiresAt: Schema.Number })

/** Native hibernation handlers; never run a socket-lifetime Effect in this object. */
export const RepositoryLive = Cloudflare.DurableObject<DurableObjectShape>()(
  "RepositoryLive",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState
    return Effect.gen(function* () {
      const Pair = (
        globalThis as unknown as {
          WebSocketRequestResponsePair: new (
            request: string,
            response: string,
          ) => NonNullable<ReturnType<typeof state.raw.getWebSocketAutoResponse>>
        }
      ).WebSocketRequestResponsePair
      yield* state.setWebSocketAutoResponse(new Pair("ping", "pong"))
      const expiry = (socket: Cloudflare.WebSocket) =>
        Schema.decodeUnknownSync(Attachment)(socket.deserializeAttachment()).expiresAt
      const close = (socket: Cloudflare.WebSocket, code: number, reason: string) =>
        socket.close(code, reason).pipe(Effect.catchCause(() => Effect.void))
      const clean = Effect.gen(function* () {
        let next = Infinity
        for (const socket of yield* state.getWebSockets()) {
          const until = expiry(socket)
          if (until <= Date.now()) yield* close(socket, 4001, "Session expired")
          else next = Math.min(next, until)
        }
        if (Number.isFinite(next)) yield* Effect.promise(() => state.raw.storage.setAlarm(next))
        else yield* Effect.promise(() => state.raw.storage.deleteAlarm())
      })
      return {
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const url = new URL(request.url, "https://live.internal")
          if (request.method === "POST" && url.pathname === "/notify") {
            const notice = yield* request.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(LiveNotice)),
              Effect.orDie,
            )
            const encoded = JSON.stringify({
              _tag: "Changed",
              revision: notice.revision,
              topics: notice.topics,
            })
            for (const socket of yield* state.getWebSockets()) {
              if (notice.disconnected) yield* close(socket, 4003, "Repository disconnected")
              else if (expiry(socket) <= Date.now()) yield* close(socket, 4001, "Session expired")
              else
                yield* socket
                  .send(encoded)
                  .pipe(Effect.catchCause(() => close(socket, 1011, "Send failed")))
            }
            yield* clean
            return HttpServerResponse.empty({ status: 204 })
          }
          const expiresAt = Number(url.searchParams.get("expiresAt"))
          if (
            request.method !== "GET" ||
            url.pathname !== "/connect" ||
            request.headers.upgrade?.toLowerCase() !== "websocket" ||
            !Number.isFinite(expiresAt) ||
            expiresAt <= Date.now()
          )
            return HttpServerResponse.empty({ status: 400 })
          const [response, socket] = yield* Cloudflare.upgrade()
          socket.serializeAttachment({ expiresAt })
          yield* socket.send(JSON.stringify({ _tag: "Ready" }))
          yield* clean
          return response
        }),
        alarm: () => clean,
        webSocketMessage: (socket) =>
          close(socket, 1008, "This connection receives notifications only"),
        webSocketClose: (socket) => close(socket, 1000, "Closed").pipe(Effect.andThen(clean)),
      }
    })
  }),
)
