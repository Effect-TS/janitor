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
  "review",
  "connections",
  "account",
])
class HeartbeatTimeout extends Schema.TaggedError<HeartbeatTimeout>()("HeartbeatTimeout", {}) {}
const Frame = Schema.Union([
  Schema.TaggedStruct("Ready", {}),
  Schema.TaggedStruct("Changed", {
    revision: Schema.BigIntFromString,
    topics: Schema.Array(Topic),
  }),
])
export const Model = Schema.Struct({
  visible: Schema.Boolean,
  status: Schema.Literals(["connecting", "connected", "disconnected", "denied"]),
  retry: Schema.Int,
})
export type Model = typeof Model.Type
export const init = (): Model => ({ visible: true, status: "connecting", retry: 0 })
/**
 * Messages carry the repository ID so a late frame from a repository the
 * page has left can be ignored.
 */
export const Message = defineMessageUnion({
  Received: { channel: Schema.String, topics: Schema.Array(Topic), connected: Schema.Boolean },
  Disconnected: { channel: Schema.String, denied: Schema.Boolean },
  Visibility: { visible: Schema.Boolean },
  Retry: {},
})
export type Message = typeof Message.Type
export type State = Model & { channel: string; endpoint: string }

export const APPLICATION_CHANNEL = "application"
export const applicationEndpoint = "/api/v1/live"

export const repositoryEndpoint = (repositoryId: string) =>
  `/api/v1/repositories/${encodeURIComponent(repositoryId)}/live`

/** Effect Socket owns the browser connection and closes it when this subscription is cancelled. */
const connection = (channel: string, endpoint: string) =>
  Stream.callback<Message, never, HttpClient.HttpClient>((queue) =>
    Effect.gen(function* () {
      let attempt = 0
      const revisions = new Map<typeof Topic.Type, bigint>()
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
          yield* Queue.offer(queue, Message.Disconnected({ channel, denied: true }))
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
                  const topics =
                    frame._tag === "Ready"
                      ? []
                      : frame.topics.filter((topic) => {
                          if ((revisions.get(topic) ?? -1n) >= frame.revision) return false
                          revisions.set(topic, frame.revision)
                          return true
                        })
                  if (frame._tag === "Changed" && topics.length === 0) return
                  yield* Queue.offer(
                    queue,
                    Message.Received({
                      channel,
                      connected: frame._tag === "Ready",
                      topics,
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
          // 4003 is the server's refusal to continue: the repository was
          // disconnected, or this teammate's membership was removed.
          if (
            result._tag === "Failure" &&
            result.failure._tag === "SocketError" &&
            result.failure.reason._tag === "SocketCloseError" &&
            result.failure.reason.code === 4003
          ) {
            yield* Queue.offer(
              queue,
              Message.Received({ channel, connected: false, topics: ["repository"] }),
            )
            yield* Queue.offer(queue, Message.Disconnected({ channel, denied: true }))
            return yield* Effect.never
          }
        }
        yield* Queue.offer(queue, Message.Disconnected({ channel, denied: false }))
        const delay = Math.min(60000, 1000 * 2 ** Math.min(attempt++, 6))
        yield* Effect.sleep(delay * (0.75 + Math.random() * 0.5))
      }
    }).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal)),
  )

export const subscriptions = Subscription.make<State, Message, HttpClient.HttpClient>()(
  (entry) => ({
    liveSocket: entry(
      {
        channel: Schema.String,
        endpoint: Schema.String,
        visible: Schema.Boolean,
        retry: Schema.Int,
      },
      {
        modelToDependencies: (model) => ({
          channel: model.channel,
          endpoint: model.endpoint,
          visible: model.visible,
          retry: model.retry,
        }),
        dependenciesToStream: ({ channel, endpoint, visible }) =>
          channel && visible ? connection(channel, endpoint) : Stream.empty,
      },
    ),
    liveVisibility: entry(
      {},
      {
        modelToDependencies: () => ({}),
        dependenciesToStream: () =>
          Stream.concat(
            Stream.fromEffect(Effect.sync(() => Message.Visibility({ visible: !document.hidden }))),
            Subscription.fromEvent({
              target: () => document,
              type: "visibilitychange",
              mapEvent: () => Message.Visibility({ visible: !document.hidden }),
            }),
          ),
      },
    ),
  }),
)
