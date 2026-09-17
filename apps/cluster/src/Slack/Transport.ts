import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { SlackConfig } from "./Config.ts"

export class SlackTransportError extends Schema.TaggedError<SlackTransportError>()(
  "SlackTransportError",
  {
    message: Schema.String,
    disposition: Schema.Literals(["retry", "uncertain", "denied"]),
    retryAfter: Schema.Number,
  },
) {}
export const SlackFetch = Context.Reference<typeof globalThis.fetch>("Slack/Fetch", {
  defaultValue: () => globalThis.fetch,
})
export class SlackTransport extends Context.Service<
  SlackTransport,
  {
    readonly channel: (
      channel: string,
    ) => Effect.Effect<
      { readonly is_private: boolean; readonly is_member: boolean },
      SlackTransportError
    >
    readonly post: (
      channel: string,
      root: string,
      text: string,
      marker: string,
    ) => Effect.Effect<string, SlackTransportError>
    readonly update: (
      channel: string,
      ts: string,
      text: string,
      marker: string,
    ) => Effect.Effect<string, SlackTransportError>
  }
>()("@janitor/cluster/Slack/Transport") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const config = yield* SlackConfig
      const fetch = yield* SlackFetch
      const call = (method: string, parameters: Record<string, unknown>, write = false) =>
        Effect.tryPromise({
          try: async () => {
            const url = new URL(`https://slack.com/api/${method}`)
            if (!write)
              for (const [key, value] of Object.entries(parameters))
                url.searchParams.set(key, String(value))
            const response = await fetch(url, {
              method: write ? "POST" : "GET",
              headers: {
                authorization: `Bearer ${Redacted.value(config.token)}`,
                "content-type": "application/json; charset=utf-8",
              },
              ...(write ? { body: JSON.stringify(parameters) } : {}),
              signal: AbortSignal.timeout(10_000),
            })
            const delay = Number(response.headers.get("retry-after") ?? 1)
            const retryAfter = Number.isFinite(delay) && delay > 0 ? delay : 1
            if (response.status === 429)
              throw new SlackTransportError({
                message: "Slack rate limited the request",
                disposition: "retry",
                retryAfter,
              })
            if (!response.ok)
              throw new SlackTransportError({
                message: `Slack HTTP ${response.status}`,
                disposition: write ? "uncertain" : "retry",
                retryAfter: 30,
              })
            const body: unknown = await response.json()
            const result = Schema.decodeUnknownSync(
              Schema.Struct({ ok: Schema.Boolean, error: Schema.optionalKey(Schema.String) }),
            )(body)
            if (!result.ok) {
              const message = result.error ?? "Slack refused the request"
              throw new SlackTransportError({
                message,
                disposition:
                  message === "ratelimited"
                    ? "retry"
                    : [
                          "internal_error",
                          "fatal_error",
                          "request_timeout",
                          "service_unavailable",
                        ].includes(message)
                      ? write
                        ? "uncertain"
                        : "retry"
                      : "denied",
                retryAfter,
              })
            }
            return body
          },
          catch: (error) =>
            error instanceof SlackTransportError
              ? error
              : new SlackTransportError({
                  message: "Slack request did not return a valid response",
                  disposition: write ? "uncertain" : "retry",
                  retryAfter: 30,
                }),
        })
      const decode =
        <A>(schema: Schema.Codec<A, unknown>, write = false) =>
        (body: unknown) =>
          Schema.decodeUnknownEffect(schema)(body).pipe(
            Effect.mapError(
              () =>
                new SlackTransportError({
                  message: "Invalid Slack response",
                  disposition: write ? "uncertain" : "retry",
                  retryAfter: 30,
                }),
            ),
          )
      const metadata = (marker: string) => ({
        event_type: "janitor_output",
        event_payload: { marker },
      })
      const textOptions = { mrkdwn: false, unfurl_links: false, unfurl_media: false }
      const sent = decode(
        Schema.Struct({ ts: Schema.String.check(Schema.isPattern(/^\d+\.\d+$/)) }),
        true,
      )
      return {
        channel: (channel) =>
          call("conversations.info", { channel }).pipe(
            Effect.flatMap(
              decode(
                Schema.Struct({
                  channel: Schema.Struct({ is_private: Schema.Boolean, is_member: Schema.Boolean }),
                }),
              ),
            ),
            Effect.map((body) => body.channel),
          ),
        post: (channel, root, text, marker) =>
          call(
            "chat.postMessage",
            {
              channel,
              thread_ts: root,
              text,
              metadata: metadata(marker),
              ...textOptions,
            },
            true,
          ).pipe(
            Effect.flatMap(sent),
            Effect.map((body) => body.ts),
          ),
        update: (channel, ts, text, marker) =>
          call(
            "chat.update",
            {
              channel,
              ts,
              text,
              metadata: metadata(marker),
              ...textOptions,
            },
            true,
          ).pipe(
            Effect.flatMap(sent),
            Effect.map((body) => body.ts),
          ),
      }
    }),
  )
}
