import * as Clock from "effect/Clock"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Hex from "effect/encoding/Hex"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

export class WebhookVerifier extends Context.Service<
  WebhookVerifier,
  {
    readonly verify: (
      signature: string,
      body: Uint8Array,
    ) => Effect.Effect<boolean, InvalidSignatureError | VerifySignatureError>
  }
>()("@janitor/cluster/Ingress/WebhookVerifier") {}

export class InvalidSignatureError extends Data.TaggedError("InvalidSignatureError")<{
  readonly signature: string
  readonly cause: unknown
}> {
  override get message(): string {
    return `Unable to verify signature with invalid format: '${this.signature}'`
  }
}

export class VerifySignatureError extends Data.TaggedError("VerifySignatureError")<{
  readonly cause: unknown
}> {}

export interface WebhookVerifierConfig {
  readonly secret: Redacted.Redacted<string>
}

/**
 * An HMAC-SHA-256 signature check: `prefix` and the hex digest of the signed
 * bytes, keyed with the secret.
 */
const makeHmac = Effect.fnUntraced(function* (secret: Redacted.Redacted<string>, prefix: string) {
  const decodeSignature = Schema.decodeEffect(
    Schema.String.check(Schema.isPattern(new RegExp(`^${prefix}[0-9a-f]{64}$`, "i"))),
  )

  const key = yield* Effect.promise(() =>
    crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(Redacted.value(secret)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    ),
  )

  return Effect.fnUntraced(function* (signature: string, signed: Uint8Array) {
    const hex = yield* Effect.mapBoth(decodeSignature(signature), {
      onSuccess: (signature) => signature.slice(prefix.length),
      onFailure: (cause) => new InvalidSignatureError({ signature, cause }),
    })
    const bytes = yield* Effect.fromResult(Hex.decode(hex)).pipe(
      Effect.mapError((cause) => new InvalidSignatureError({ signature, cause })),
    )
    return yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.verify("HMAC", key, bytes as Uint8Array<ArrayBuffer>, new Uint8Array(signed)),
      catch: (cause) => new VerifySignatureError({ cause }),
    })
  })
})

const make = Effect.fnUntraced(function* ({ secret }: WebhookVerifierConfig) {
  const check = yield* makeHmac(secret, "sha256=")
  return {
    verify: Effect.fn("WebhookVerifier.verify")(function* (signature: string, body: Uint8Array) {
      return yield* check(signature, body)
    }),
  }
})

/** Builds the verifier from an already resolved secret. */
export const layerFrom = (config: WebhookVerifierConfig): Layer.Layer<WebhookVerifier> =>
  Layer.effect(WebhookVerifier, make(config))

export const layer = (
  config: Config.Wrap<WebhookVerifierConfig>,
): Layer.Layer<WebhookVerifier, Config.ConfigError> =>
  Layer.effect(WebhookVerifier, Effect.flatMap(Config.unwrap(config), make))

/**
 * Slack's format: `X-Slack-Signature` is `v0=` and the hex HMAC-SHA-256 of
 * `v0:{X-Slack-Request-Timestamp}:{body}`. A timestamp more than 300 seconds
 * from now fails the check, so a captured request can't be replayed.
 */
export class SlackWebhookVerifier extends Context.Service<
  SlackWebhookVerifier,
  {
    readonly verify: (request: {
      readonly signature: string
      readonly timestamp: string
      readonly body: Uint8Array
    }) => Effect.Effect<boolean, InvalidSignatureError | VerifySignatureError>
  }
>()("@janitor/cluster/Ingress/WebhookVerifier/SlackWebhookVerifier") {}

const SLACK_WINDOW_SECONDS = 300

const makeSlack = Effect.fnUntraced(function* ({ secret }: WebhookVerifierConfig) {
  const check = yield* makeHmac(secret, "v0=")
  return {
    verify: Effect.fn("SlackWebhookVerifier.verify")(function* (request: {
      readonly signature: string
      readonly timestamp: string
      readonly body: Uint8Array
    }) {
      const now = (yield* Clock.currentTimeMillis) / 1000
      if (
        !/^\d+$/.test(request.timestamp) ||
        Math.abs(now - Number(request.timestamp)) > SLACK_WINDOW_SECONDS
      )
        return false
      const prefix = new TextEncoder().encode(`v0:${request.timestamp}:`)
      const signed = new Uint8Array(prefix.length + request.body.length)
      signed.set(prefix)
      signed.set(request.body, prefix.length)
      return yield* check(request.signature, signed)
    }),
  }
})

/** Builds Slack's verifier from an already resolved signing secret. */
export const slackLayerFrom = (config: WebhookVerifierConfig): Layer.Layer<SlackWebhookVerifier> =>
  Layer.effect(SlackWebhookVerifier, makeSlack(config))
