import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Socket from "effect/unstable/socket/Socket"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as Subscription from "foldkit/subscription"
import { defineMessageUnion } from "foldkit/message"

export const Topic = Schema.Literals([
  "configuration",
  "activity",
  "sync",
  "candidates",
  "consent",
  "test",
  "repository",
])
class HeartbeatTimeout extends Schema.TaggedError<HeartbeatTimeout>()("HeartbeatTimeout", {}) {}
const Frame = Schema.Union([
  Schema.TaggedStruct("Ready", {}),
  Schema.TaggedStruct("Changed", { revision: Schema.String, topics: Schema.Array(Topic) }),
])
export const Model = Schema.Struct({
  visible: Schema.Boolean,
  status: Schema.Literals(["connecting", "connected", "disconnected", "denied"]),
  retry: Schema.Int,
})
export type Model = typeof Model.Type
export const init = (): Model => ({ visible: true, status: "connecting", retry: 0 })
export const Message = defineMessageUnion({
  Received: { repositoryId: Schema.String, topics: Schema.Array(Topic), connected: Schema.Boolean },
  Disconnected: { repositoryId: Schema.String, denied: Schema.Boolean },
  Visibility: { visible: Schema.Boolean },
  Retry: {},
  Fallback: { repositoryId: Schema.String },
})
export type Message = typeof Message.Type
export type State = Model & { repositoryId: string }

/** Effect Socket owns the browser connection and closes it when this subscription is cancelled. */
const connection = (repositoryId: string) =>
  Stream.callback<Message, never, HttpClient.HttpClient>((queue) =>
    Effect.gen(function* () {
      const endpoint = `/api/v1/repositories/${encodeURIComponent(repositoryId)}/live`
      let attempt = 0
      while (true) {
        const available = yield* HttpClient.get(endpoint).pipe(
          Effect.timeout("10 seconds"),
          Effect.result,
        )
        if (
          available._tag === "Success" &&
          (available.success.status === 401 ||
            available.success.status === 403 ||
            available.success.status === 200)
        ) {
          yield* Queue.offer(queue, Message.Disconnected({ repositoryId, denied: true }))
          return yield* Effect.never
        }
        if (available._tag === "Success" && available.success.status === 204) {
          const url = new URL(endpoint, window.location.href)
          url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
          const socket = yield* Socket.makeWebSocket(url.href, {
            openTimeout: "10 seconds",
          })
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const reader = yield* socket.reader
              const { write } = yield* socket.writer
              const decoder = new TextDecoder()
              let alive = true
              const heartbeat = Effect.gen(function* () {
                while (true) {
                  yield* Effect.sleep("30 seconds")
                  alive = false
                  yield* write("ping")
                  yield* Effect.sleep("10 seconds")
                  if (!alive) return yield* new HeartbeatTimeout()
                }
              })
              const receive = (text: string) =>
                Effect.gen(function* () {
                  if (text === "pong") {
                    alive = true
                    return
                  }
                  const frame = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Frame))(
                    text,
                  )
                  attempt = 0
                  yield* Queue.offer(
                    queue,
                    Message.Received({
                      repositoryId,
                      connected: frame._tag === "Ready",
                      topics: frame._tag === "Ready" ? [] : frame.topics,
                    }),
                  )
                })
              return yield* reader.pull.pipe(
                Effect.flatMap((frames) =>
                  Effect.forEach(
                    frames,
                    (frame) => receive(typeof frame === "string" ? frame : decoder.decode(frame)),
                    { discard: true },
                  ),
                ),
                Effect.forever,
                Effect.raceFirst(heartbeat),
              )
            }),
          ).pipe(Effect.result)
          if (
            result._tag === "Failure" &&
            result.failure._tag === "SocketError" &&
            result.failure.reason._tag === "SocketCloseError" &&
            result.failure.reason.code === 4003
          ) {
            yield* Queue.offer(
              queue,
              Message.Received({ repositoryId, connected: false, topics: ["repository"] }),
            )
            yield* Queue.offer(queue, Message.Disconnected({ repositoryId, denied: true }))
            return yield* Effect.never
          }
        }
        yield* Queue.offer(queue, Message.Disconnected({ repositoryId, denied: false }))
        const delay = Math.min(60000, 1000 * 2 ** Math.min(attempt++, 6))
        yield* Effect.sleep(delay * (0.75 + Math.random() * 0.5))
      }
    }).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal)),
  )

export const subscriptions = Subscription.make<State, Message, HttpClient.HttpClient>()(
  (entry) => ({
    liveSocket: entry(
      { repositoryId: Schema.String, visible: Schema.Boolean, retry: Schema.Int },
      {
        modelToDependencies: (model) => ({
          repositoryId: model.repositoryId,
          visible: model.visible,
          retry: model.retry,
        }),
        dependenciesToStream: ({ repositoryId, visible }) =>
          repositoryId && visible ? connection(repositoryId) : Stream.empty,
      },
    ),
    liveFallback: entry(
      { repositoryId: Schema.String, visible: Schema.Boolean, status: Model.fields.status },
      {
        modelToDependencies: (model) => ({
          repositoryId: model.repositoryId,
          visible: model.visible,
          status: model.status,
        }),
        dependenciesToStream: ({ repositoryId, visible, status }) =>
          repositoryId && visible && status !== "connected" && status !== "denied"
            ? Stream.tick("60 seconds").pipe(
                Stream.drop(1),
                Stream.map(() => Message.Fallback({ repositoryId })),
              )
            : Stream.empty,
      },
    ),
    liveVisibility: entry(
      {},
      {
        modelToDependencies: () => ({}),
        dependenciesToStream: () =>
          Stream.concat(
            Stream.fromEffect(Effect.sync(() => Message.Visibility({ visible: !document.hidden }))),
            Subscription.fromEvent<Event, Message>({
              target: () => document,
              type: "visibilitychange",
              toMessage: () => Message.Visibility({ visible: !document.hidden }),
            }),
          ),
      },
    ),
  }),
)
