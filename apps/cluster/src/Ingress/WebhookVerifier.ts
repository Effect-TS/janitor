import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
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

const Signature = Schema.String.check(Schema.isPattern(/^sha256=[0-9a-f]{64}$/i))

const make = Effect.fnUntraced(function* ({ secret }: WebhookVerifierConfig) {
  const decodeSignature = Schema.decodeEffect(Signature)

  const key = yield* Effect.promise(() =>
    crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(Redacted.value(secret)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    ),
  )

  const verify = Effect.fn("WebhookVerifier.verify")(function* (
    signature: string,
    body: Uint8Array,
  ) {
    const hex = yield* Effect.mapBoth(decodeSignature(signature), {
      onSuccess: (signature) => signature.slice("sha256=".length),
      onFailure: (cause) => new InvalidSignatureError({ signature, cause }),
    })
    const bytes = yield* Effect.fromResult(Encoding.decodeHex(hex)).pipe(
      Effect.mapError((cause) => new InvalidSignatureError({ signature, cause })),
    )
    return yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.verify("HMAC", key, bytes as Uint8Array<ArrayBuffer>, new Uint8Array(body)),
      catch: (cause) => new VerifySignatureError({ cause }),
    })
  })

  return {
    verify,
  }
})

/** Builds the verifier from an already resolved secret. */
export const layerFrom = (config: WebhookVerifierConfig): Layer.Layer<WebhookVerifier> =>
  Layer.effect(WebhookVerifier, make(config))

export const layer = (
  config: Config.Wrap<WebhookVerifierConfig>,
): Layer.Layer<WebhookVerifier, Config.ConfigError> =>
  Layer.effect(WebhookVerifier, Effect.flatMap(Config.unwrap(config), make))
