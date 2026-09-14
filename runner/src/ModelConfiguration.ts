// Deployment-owned model configuration and the native model resolver.
//
// One immutable configuration record is selected per session at creation and
// retained for that session's lifetime; the deployment default only affects
// new sessions. Records name a runner secret binding, never a key value. The
// resolver feeds the pinned SDK's explicit embedding seam
// (`SessionRunnerModel.resolved`) from these records instead of a remote
// catalog or fixture metadata.
import { Duration, Effect, Layer, Redacted, Schema, Stream } from "effect"
import { HttpClient, HttpClientError } from "effect/unstable/http"
import { Auth } from "@opencode/ai/route"
import { OpenAIChat } from "@opencode/ai/protocols"
import * as OpenRouter from "@opencode/ai/providers/openrouter"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"

export const ModelConfigurationRecord = Schema.Struct({
  /** Stable configuration identity persisted per session. */
  id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]{1,80}$/)),
  /** Provider identity used in durable records and observation. */
  provider: Schema.String.check(Schema.isPattern(/^[a-z0-9-]{1,40}$/)),
  /** The provider API model identifier sent in requests; may differ from display identity. */
  apiModelId: Schema.String,
  /** Native route/transport, including OpenRouter's provider routing options. */
  route: Schema.Literals(["openai-chat", "openrouter"]),
  /** OpenRouter upstream pinned to the record's advertised limits. */
  upstreamProvider: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-z0-9/-]+$/))),
  /** Provider endpoint base URL. */
  endpoint: Schema.String.check(
    Schema.isPattern(/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1|[a-z0-9.-]+\.test)(:|\/)/),
  ),
  /** Name of the runner secret binding holding the bearer credential. Never a value. */
  secretBinding: Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]{2,80}$/)),
  capabilities: Schema.Struct({
    tools: Schema.Boolean,
    input: Schema.Array(Schema.String),
    output: Schema.Array(Schema.String),
  }),
  limit: Schema.Struct({
    context: Schema.Int.check(Schema.isGreaterThan(0)),
    output: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  cost: Schema.optionalKey(Schema.Array(Model.Cost)),
  compaction: Schema.optionalKey(Provider.Compaction),
  generation: Schema.optionalKey(
    Schema.Struct({
      maxTokens: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
  ),
})
export type ModelConfigurationRecord = typeof ModelConfigurationRecord.Type

export const ModelConfigurations = Schema.Struct({
  default: Schema.String,
  records: Schema.Array(ModelConfigurationRecord).check(Schema.isMinLength(1)),
})
export type ModelConfigurations = typeof ModelConfigurations.Type

const decodeConfigurations = Schema.decodeUnknownSync(ModelConfigurations, {
  onExcessProperty: "error",
})

export class ModelConfigurationError extends Error {
  override readonly name = "ModelConfigurationError"
}

/**
 * Parses the deployment's model configuration. A malformed or self-inconsistent
 * value is a visible configuration failure rather than a silent fallback.
 */
export const parseModelConfigurations = (raw: string | undefined): ModelConfigurations => {
  if (raw === undefined || raw.trim() === "")
    throw new ModelConfigurationError("JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS is not configured")
  let parsed: ModelConfigurations
  try {
    parsed = decodeConfigurations(JSON.parse(raw))
  } catch {
    throw new ModelConfigurationError(
      "JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS is invalid. Check the documented schema; use secret binding names, never credential values.",
    )
  }
  const ids = new Set<string>()
  for (const record of parsed.records) {
    if ((record.route === "openrouter") !== (record.upstreamProvider !== undefined))
      throw new ModelConfigurationError(
        "OpenRouter records require an upstreamProvider; other routes must omit it",
      )
    let endpoint: URL
    try {
      endpoint = new URL(record.endpoint)
    } catch {
      throw new ModelConfigurationError("Model endpoint must be an absolute URL")
    }
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
      throw new ModelConfigurationError(
        "Model endpoints must not contain credentials, query strings or fragments",
      )
    if (record.generation !== undefined && record.generation.maxTokens > record.limit.output)
      throw new ModelConfigurationError(`Output setting exceeds the limit for ${record.id}`)
    if (ids.has(record.id))
      throw new ModelConfigurationError(`Duplicate model configuration id ${record.id}`)
    ids.add(record.id)
  }
  if (!ids.has(parsed.default))
    throw new ModelConfigurationError(`Default model configuration ${parsed.default} has no record`)
  return parsed
}

export const findRecord = (configurations: ModelConfigurations, id: string) =>
  configurations.records.find((record) => record.id === id)

/** Reads a secret binding at request time; the value never leaves the request headers. */
export type SecretReader = (binding: string) => string | undefined

const credentialFor = (record: ModelConfigurationRecord, secrets: SecretReader) =>
  Auth.effect(
    Effect.suspend(() => {
      const value = secrets(record.secretBinding)
      if (typeof value !== "string" || value === "")
        return Effect.fail(
          new Auth.MissingCredentialError(`runner secret binding ${record.secretBinding}`),
        )
      return Effect.succeed(Redacted.make(value))
    }),
  )

/** Builds the native route model for a record. Secrets resolve lazily per request. */
export const languageModelFor = (record: ModelConfigurationRecord, secrets: SecretReader) => {
  const route = (record.route === "openrouter" ? OpenRouter.route : OpenAIChat.route).with({
    provider: record.provider,
    endpoint: { baseURL: record.endpoint },
    auth: Auth.bearer(credentialFor(record, secrets)),
  })
  return route.model({
    id: record.apiModelId,
    defaults: {
      ...(record.generation === undefined ? {} : { generation: record.generation }),
      ...(record.upstreamProvider === undefined
        ? {}
        : {
            providerOptions: {
              provider: {
                only: [record.upstreamProvider],
                allow_fallbacks: false,
                require_parameters: true,
              },
            },
          }),
    },
  })
}

export const resolvedFor = (
  record: ModelConfigurationRecord,
  secrets: SecretReader,
): SessionRunnerModel.Resolved =>
  SessionRunnerModel.resolved(languageModelFor(record, secrets), {
    capabilities: { ...record.capabilities },
    cost: record.cost ?? [],
    limit: record.limit,
    ...(record.compaction === undefined ? {} : { compaction: record.compaction }),
  })

/**
 * The runner's `SessionRunnerModel` implementation. `selection` reads the
 * session's persisted configuration id; a missing or retired record is an
 * actionable configuration error, never a substitute model.
 */
export const resolverLayer = (
  configurations: ModelConfigurations,
  selection: () => string | undefined,
  secrets: SecretReader,
) =>
  Layer.succeed(
    SessionRunnerModel.Service,
    SessionRunnerModel.Service.of({
      resolve: (session) =>
        Effect.suspend(() => {
          const id = selection()
          const record = id === undefined ? undefined : findRecord(configurations, id)
          if (record === undefined)
            return Effect.fail(
              new ModelResolver.ModelConfigurationError({
                providerID: Provider.ID.make(session.model?.providerID ?? "janitor"),
                modelID: Model.ID.make(session.model?.id ?? id ?? "unselected"),
                package: "@janitor/runner",
                detail:
                  id === undefined
                    ? "The session has no persisted model configuration"
                    : `Model configuration ${id} is not available in this deployment`,
              }),
            )
          return Effect.succeed(resolvedFor(record, secrets))
        }),
    }),
  )

export const DEFAULT_MODEL_INACTIVITY = Duration.minutes(5)

/** Remove echoed bearer credentials before native errors or events can persist them. */
export const withCredentialRedaction = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  HttpClient.make((request) => {
    const credential = request.headers.authorization?.replace(/^Bearer /i, "")
    if (!credential) return client.execute(request)
    const redact = (text: string) =>
      text
        .replaceAll(JSON.stringify(credential).slice(1, -1), "[REDACTED]")
        .replaceAll(credential, "[REDACTED]")
    return client.execute(request).pipe(
      Effect.map((response) =>
        Object.create(response, {
          text: { value: response.text.pipe(Effect.map(redact)) },
          stream: {
            value: response.stream.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.map((line) => new TextEncoder().encode(redact(line) + "\n")),
            ),
          },
        }),
      ),
    )
  })

/**
 * Applies the model-response inactivity deadline at the HTTP boundary: the wait
 * for response headers and every gap in the body stream. Native transport error
 * classification and retry scheduling stay intact because the failure is an
 * ordinary transport error. Tool execution time is outside this timer.
 */
export const withInactivityDeadline = (
  client: HttpClient.HttpClient,
  deadline: Duration.Duration,
): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    client.execute(request).pipe(
      Effect.timeoutOrElse({
        duration: deadline,
        orElse: () =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause: new Error(`No model response within ${Duration.format(deadline)}`),
              }),
            }),
          ),
      }),
      Effect.map((response) => {
        const stream = response.stream.pipe(
          Stream.timeoutOrElse({
            duration: deadline,
            orElse: () =>
              Stream.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({
                    request,
                    cause: new Error(`Model response stalled for ${Duration.format(deadline)}`),
                  }),
                }),
              ),
          }),
        )
        return Object.create(response, {
          stream: { value: stream },
          // Native HTTP failures read text rather than SSE. They must use the
          // same byte-level inactivity timer as successful response streams.
          text: {
            value: stream.pipe(
              Stream.decodeText(),
              Stream.runCollect,
              Effect.map((chunks) => chunks.join("")),
            ),
          },
        })
      }),
    ),
  )
