import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import {
  type Actor,
  type AiConsent,
  type ConfiguredRule,
  AiConsentState,
  PolicyVersionId,
} from "@janitor/domain/Labeling/Policy/Configuration"
import { evaluateApplicability, type Resolver } from "@janitor/domain/Labeling/Policy/Evaluate"
import type { FactSnapshot } from "@janitor/domain/Labeling/Policy/Facts"
import type {
  ClassifierEvaluator,
  Evaluation,
  Program,
} from "@janitor/domain/Labeling/Policy/Program"
import {
  prepareClassifierInput,
  SYSTEM_INSTRUCTIONS,
  DEFAULT_INPUT_BYTES,
  AiInputReport,
  AiReasonCode,
} from "@janitor/domain/Labeling/Policy/AiInput"
import * as Clock from "effect/Clock"
import * as Cause from "effect/Cause"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as AiError from "effect/unstable/ai/AiError"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describeError } from "../SqlErrors.ts"

/**
 * Classifier evaluation (plan: "Classifier evaluator"). The provider is
 * one small interface so tests stub it; consent, leases, caching, and the
 * prompt contract live here and never in the provider.
 */

// PROVIDER

export const ClassifierAnswer = Schema.Struct({
  matches: Schema.NullOr(Schema.Boolean),
  confidence: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  reason: Schema.String.check(Schema.isMaxLength(1_000)),
})
export type ClassifierAnswer = typeof ClassifierAnswer.Type

export class ClassifierProviderError extends Data.TaggedError("ClassifierProviderError")<{
  readonly message: string
  readonly cause: unknown
  readonly retryable?: boolean
  readonly retryAfterMs?: number
}> {}

export interface ProviderIdentity {
  readonly provider: string
  readonly model: string
}

const providerRetry = (cause: unknown, now: number) => {
  if (Cause.isTimeoutError(cause)) return { retryable: true }
  if (!AiError.isAiError(cause)) return { retryable: false }
  const reason = cause.reason
  const headers = "http" in reason ? reason.http?.response?.headers : undefined
  const header = headers?.["retry-after"]
  const seconds = typeof header === "string" && header.trim() !== "" ? Number(header) : NaN
  const date = typeof header === "string" ? Date.parse(header) : NaN
  const guidance = Number.isFinite(seconds)
    ? Math.max(0, seconds * 1000)
    : Number.isFinite(date)
      ? Math.max(0, date - now)
      : 0
  const retryAfterMs = Math.max(
    guidance,
    reason._tag === "RateLimitError" && reason.retryAfter
      ? Duration.toMillis(reason.retryAfter)
      : 0,
  )
  return { retryable: reason.isRetryable, retryAfterMs }
}

// Provider payloads may echo prompts or credentials. Return guidance, never raw bodies.
const providerErrorMessage = (cause: unknown): string => {
  if (Cause.isTimeoutError(cause)) return "The AI provider timed out after 60 seconds. Try again."
  if (AiError.isAiError(cause)) {
    switch (cause.reason._tag) {
      case "AuthenticationError":
        return "The AI provider rejected authentication. Check the server's API key (OPENAI_API_KEY) and provider permissions."
      case "InvalidRequestError":
      case "UnsupportedSchemaError":
        return "The AI provider rejected the request. Check OPENAI_API_URL and LABELING_AI_MODEL and confirm the model supports structured responses."
      case "QuotaExhaustedError":
        return "The AI provider quota is exhausted. Check the provider's billing and usage limits."
      case "RateLimitError":
        return "The AI provider rate limit was reached. Wait and try again."
      case "InvalidOutputError":
      case "StructuredOutputError":
        return "The AI provider returned an invalid classification. Try again or configure a model that supports structured responses."
      case "ContentPolicyError":
        return "The AI provider rejected the content. Review the rule prompt and referenced facts."
      case "NetworkError":
        return "Could not reach the AI provider. Check OPENAI_API_URL and connectivity, then try again."
    }
  }
  return "The AI provider could not complete the request. Try again; if it persists, check the provider's status and server configuration."
}

export class ClassifierProvider extends Context.Service<
  ClassifierProvider,
  {
    readonly identity: ProviderIdentity
    readonly ask: (prompt: string) => Effect.Effect<ClassifierAnswer, ClassifierProviderError>
  }
>()("@janitor/cluster/Labeling/Classifier/ClassifierProvider") {
  /** The language model answers a bounded question; evidence is untrusted text. */
  static readonly fromLanguageModel = (identity: ProviderIdentity) =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const model = yield* LanguageModel.LanguageModel
        return {
          identity,
          ask: (prompt) =>
            model
              .generateObject({
                objectName: "classification",
                schema: ClassifierAnswer,
                prompt: [
                  {
                    role: "system",
                    content: SYSTEM_INSTRUCTIONS,
                  },
                  { role: "user", content: [{ type: "text", text: prompt }] },
                ],
              })
              .pipe(
                Effect.timeout(Duration.seconds(60)),
                Effect.tap((response) =>
                  Effect.logInfo("AI classifier usage").pipe(
                    Effect.annotateLogs({
                      provider: identity.provider,
                      model: identity.model,
                      inputTokens: response.usage.inputTokens.total,
                      outputTokens: response.usage.outputTokens.total,
                    }),
                  ),
                ),
                Effect.map((response) => response.value),
                Effect.catch((cause) =>
                  Effect.flatMap(Clock.currentTimeMillis, (now) =>
                    Effect.fail(
                      new ClassifierProviderError({
                        message: providerErrorMessage(cause),
                        cause,
                        ...providerRetry(cause, now),
                      }),
                    ),
                  ),
                ),
              ),
        }
      }),
    )

  /** What runs when no API key is configured: classification fails without sending data. */
  static readonly unavailable = Layer.succeed(this, {
    identity: { provider: "none", model: "none" },
    ask: () =>
      Effect.fail(
        new ClassifierProviderError({
          message: "No classifier provider is configured",
          cause: null,
        }),
      ),
  })
}

export const DEFAULT_MODEL = "gpt-5.6-luna"

export interface ProviderConfig {
  readonly apiKey: Option.Option<Redacted.Redacted<string>>
  readonly apiUrl: Option.Option<string>
  readonly model: string
}

/** Reads the provider key and model from the environment; absent key means unavailable. */
export const providerConfig: Config.Wrap<ProviderConfig> = {
  apiKey: Config.option(Config.Redacted("OPENAI_API_KEY")),
  apiUrl: Config.option(Config.String("OPENAI_API_URL")),
  model: Config.String("LABELING_AI_MODEL").pipe(Config.withDefault(DEFAULT_MODEL)),
}

/** Deployment-wide lifetime, in whole seconds. */
export const aiCacheTtlConfig = Config.schema(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2147483647 })),
  "LABELING_AI_CACHE_TTL_SECONDS",
).pipe(Config.withDefault(86400))

export const AiCacheTtl = Context.Reference<number>("@janitor/AiCacheTtl", {
  defaultValue: () => 86400,
})

// CONSENT

export class AiConsentError extends Data.TaggedError("AiConsentError")<{
  readonly operation: string
  readonly message: string
}> {}

const ConsentRow = Schema.Struct({
  repository_id: GitHubRepositoryDatabaseId,
  state: AiConsentState,
  provider: Schema.String,
  model: Schema.String,
  active_leases: Schema.FiniteFromString,
  updated_at: Schema.DateTimeUtcFromDate,
})

/** How long a provider call may hold a lease before it is presumed dead. */
export const LEASE_TTL = Duration.minutes(2)

export class AiConsentService extends Context.Service<
  AiConsentService,
  {
    readonly get: (
      repositoryId: GitHubRepositoryDatabaseId,
    ) => Effect.Effect<AiConsent, AiConsentError>
    /** Enabling records the provider and model consented to; disabling drains. */
    readonly set: (
      repositoryId: GitHubRepositoryDatabaseId,
      enabled: boolean,
      actor: Actor,
    ) => Effect.Effect<AiConsent, AiConsentError>
    /** Moves draining repositories with no live lease to disabled. Returns how many. */
    readonly settleDraining: Effect.Effect<number, AiConsentError>
  }
>()("@janitor/cluster/Labeling/Classifier/AiConsentService", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const provider = yield* ClassifierProvider
    const decodeRows = Schema.decodeUnknownEffect(Schema.Array(ConsentRow))
    const wrap =
      (operation: string) =>
      <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
        Effect.mapError(
          effect,
          (error) => new AiConsentError({ operation, message: describeError(error) }),
        )

    const read = (repositoryId: GitHubRepositoryDatabaseId) =>
      sql`
        SELECT c.repository_id, c.state, c.provider, c.model, c.updated_at,
               (SELECT count(*)::text FROM labeling_ai_lease l
                WHERE l.repository_id = c.repository_id AND l.released_at IS NULL
                  AND l.expires_at > CLOCK_TIMESTAMP()) AS active_leases
        FROM labeling_ai_consent c WHERE c.repository_id = ${repositoryId}
      `.pipe(
        Effect.flatMap(decodeRows),
        Effect.map((rows) => rows[0]),
      )

    const toConsent = (
      repositoryId: GitHubRepositoryDatabaseId,
      row: typeof ConsentRow.Type | undefined,
    ): Effect.Effect<AiConsent> =>
      row === undefined
        ? Effect.map(Clock.currentTimeMillis, (now) => ({
            repositoryId,
            state: "disabled" as const,
            provider: provider.identity.provider,
            model: provider.identity.model,
            activeLeases: 0,
            updatedAt: DateTime.makeUnsafe(now),
          }))
        : Effect.succeed({
            repositoryId,
            state: row.state,
            provider: row.provider,
            model: row.model,
            activeLeases: row.active_leases,
            updatedAt: row.updated_at,
          })

    const get = Effect.fn("AiConsentService.get")(function* (
      repositoryId: GitHubRepositoryDatabaseId,
    ) {
      const row = yield* read(repositoryId).pipe(wrap("get"))
      return yield* toConsent(repositoryId, row)
    })

    const set = Effect.fn("AiConsentService.set")(
      function* (repositoryId: GitHubRepositoryDatabaseId, enabled: boolean, actor: Actor) {
        const membership =
          yield* sql`SELECT repository_id FROM github_repository WHERE repository_id=${repositoryId} AND connected FOR UPDATE`.pipe(
            wrap("set"),
          )
        if (!membership.length)
          return yield* new AiConsentError({
            operation: "set",
            message: "Repository is disconnected",
          })
        const current = yield* read(repositoryId).pipe(wrap("set"))
        // Disabling with live leases drains first; the settle pass finishes it.
        const state: AiConsent["state"] = enabled
          ? "enabled"
          : (current?.active_leases ?? 0) > 0
            ? "draining"
            : "disabled"
        yield* sql`
        INSERT INTO labeling_ai_consent (repository_id, state, provider, model, actor_issuer, actor_subject)
        VALUES (${repositoryId}, ${state}, ${provider.identity.provider}, ${provider.identity.model},
                ${actor.issuer}, ${actor.subject})
        ON CONFLICT (repository_id) DO UPDATE SET
          state = EXCLUDED.state,
          provider = CASE WHEN EXCLUDED.state = 'enabled' THEN EXCLUDED.provider ELSE labeling_ai_consent.provider END,
          model = CASE WHEN EXCLUDED.state = 'enabled' THEN EXCLUDED.model ELSE labeling_ai_consent.model END,
          actor_issuer = EXCLUDED.actor_issuer, actor_subject = EXCLUDED.actor_subject,
          updated_at = CLOCK_TIMESTAMP()
      `.pipe(wrap("set"))
        yield* Effect.logInfo("Changed AI consent").pipe(
          Effect.annotateLogs({ repositoryId, state, actor: actor.subject }),
        )
        return yield* get(repositoryId)
      },
      (effect) => sql.withTransaction(effect).pipe(wrap("set")),
    )

    const settleDraining = sql`
      UPDATE labeling_ai_consent c SET state = 'disabled', updated_at = CLOCK_TIMESTAMP()
      WHERE c.state = 'draining' AND NOT EXISTS (
        SELECT 1 FROM labeling_ai_lease l
        WHERE l.repository_id = c.repository_id AND l.released_at IS NULL AND l.expires_at > CLOCK_TIMESTAMP()
      )
      RETURNING c.repository_id
    `.pipe(
      Effect.map((rows) => rows.length),
      wrap("settleDraining"),
    )

    return { get, set, settleDraining }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

// CLASSIFIER

export class ClassifierError extends Data.TaggedError("ClassifierError")<{
  readonly operation: string
  readonly message: string
}> {}

/** Workflow-owned freshness checks and progress persistence, evaluated on every attempt. */
export const EvaluationRetry = Context.Reference<{
  /** Newer snapshots must not wait on a request owned by superseded work. */
  readonly claimKey?: string
  readonly isCurrent: Effect.Effect<boolean, ClassifierError>
  readonly report: (message: string) => Effect.Effect<void, ClassifierError>
}>("@janitor/EvaluationRetry", {
  defaultValue: () => ({ isCurrent: Effect.succeed(true), report: () => Effect.void }),
})

export interface ClassifyInput {
  readonly rule?: Omit<ConfiguredRule, "policyVersionId">
  readonly inspectInput?: boolean
  readonly repositoryId: GitHubRepositoryDatabaseId
  readonly number: number
  readonly policyVersionId: PolicyVersionId
  readonly program: Program
  readonly evaluator: ClassifierEvaluator
  readonly snapshot: FactSnapshot
  readonly resolve: Resolver
}

const DecisionRow = Schema.Struct({
  input_report: Schema.NullOr(AiInputReport),
  reason_code: Schema.NullOr(AiReasonCode),
  outcome: Schema.Literals(["match", "no-match", "unknown"]),
  confidence: Schema.Finite,
  reason: Schema.String,
})

const sha256Hex = (text: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).pipe(
    Effect.map((digest) => Encoding.encodeHex(new Uint8Array(digest))),
  )

/**
 * Evaluates a classifier policy for one snapshot: applicability purely,
 * then consent, a lease, the decision cache, and finally the provider.
 * Missing evidence remains unknown; a completed answer below the confidence
 * threshold is a non-match. Operational failures preserve labels.
 */
export const AiInputBudget = Context.Reference<number>("@janitor/AiInputBudget", {
  defaultValue: () => DEFAULT_INPUT_BYTES,
})

export class AiClassifier extends Context.Service<
  AiClassifier,
  {
    readonly classify: (input: ClassifyInput) => Effect.Effect<Evaluation, ClassifierError>
  }
>()("@janitor/cluster/Labeling/Classifier/AiClassifier", {
  make: Effect.gen(function* () {
    const inputBudget = yield* AiInputBudget
    const cacheTtl = yield* AiCacheTtl
    const sql = yield* SqlClient.SqlClient
    const provider = yield* ClassifierProvider
    const consent = yield* AiConsentService
    const decodeDecisions = Schema.decodeUnknownEffect(Schema.Array(DecisionRow))
    const wrap =
      (operation: string) =>
      <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
        Effect.mapError(
          effect,
          (error) => new ClassifierError({ operation, message: describeError(error) }),
        )

    const unknown = (
      reason: string,
      trace: Evaluation["trace"],
      reasonCode: AiReasonCode,
    ): Evaluation => ({
      reasonCode,
      outcome: "unknown",
      reason,
      trace,
    })

    const acquireLease = (repositoryId: GitHubRepositoryDatabaseId) =>
      Effect.gen(function* () {
        // The lease is granted only while consent is enabled, in one statement,
        // so a revocation racing this call cannot let it through.
        yield* sql`SELECT pg_advisory_xact_lock(hashtext('labeling-ai-budget'))`
        const leaseId = crypto.randomUUID()
        const granted = yield* sql<{ lease_id: string }>`
          INSERT INTO labeling_ai_lease (lease_id, repository_id, expires_at)
          SELECT ${leaseId}, ${repositoryId}, CLOCK_TIMESTAMP() + ${Duration.toSeconds(LEASE_TTL)} * INTERVAL '1 second'
          WHERE EXISTS (SELECT 1 FROM labeling_ai_consent WHERE repository_id = ${repositoryId} AND state = 'enabled' AND EXISTS(SELECT 1 FROM github_repository r WHERE r.repository_id = ${repositoryId} AND r.connected))
          AND (SELECT count(*) FROM labeling_ai_lease WHERE released_at IS NULL AND expires_at>CLOCK_TIMESTAMP()) < 8
          AND (SELECT count(*) FROM labeling_ai_lease WHERE repository_id=${repositoryId} AND released_at IS NULL AND expires_at>CLOCK_TIMESTAMP()) < 2
          AND (SELECT count(*) FROM labeling_ai_lease WHERE repository_id=${repositoryId} AND acquired_at>CLOCK_TIMESTAMP()-INTERVAL '1 hour') < 100
          RETURNING lease_id
        `
        return granted.length === 0 ? Option.none() : Option.some(leaseId)
      }).pipe(sql.withTransaction)

    const releaseLease = (leaseId: string) =>
      sql`UPDATE labeling_ai_lease SET released_at = CLOCK_TIMESTAMP() WHERE lease_id = ${leaseId}`.pipe(
        Effect.ignore,
      )

    const classify = Effect.fn("AiClassifier.classify")(function* (input: ClassifyInput) {
      const retry = yield* EvaluationRetry
      // Applicability and target are decided purely; only the question needs a provider.
      const scoped = evaluateApplicability({
        program: input.program,
        snapshot: input.snapshot,
        resolve: input.resolve,
      })
      if (scoped.outcome !== "match") return scoped
      const trace = scoped.trace

      const missing = input.evaluator.evidence.filter(
        (fact) => input.snapshot.facts[fact] === undefined,
      )
      if (missing.length)
        return unknown(
          "Evidence unavailable or incomplete: " + missing.join(", "),
          trace,
          "missing-evidence",
        )
      const state = yield* consent.get(input.repositoryId).pipe(wrap("consent"))
      if (state.state !== "enabled")
        return unknown(
          `AI access is ${state.state}. Enable it in repository settings.`,
          trace,
          "access-disabled",
        )
      if (provider.identity.provider === "none")
        return {
          outcome: "failed",
          reason: "No AI provider is configured. Set OPENAI_API_KEY on the server.",
          reasonCode: "provider-unavailable",
          trace,
        } satisfies Evaluation
      if (state.provider !== provider.identity.provider || state.model !== provider.identity.model)
        return unknown(
          "AI provider changed. Enable AI access again in repository settings.",
          trace,
          "access-disabled",
        )
      const rendered = prepareClassifierInput(
        input.evaluator.prompt,
        input.evaluator.evidence,
        input.snapshot,
        inputBudget,
      )
      if (rendered._tag === "Rejected")
        return {
          ...unknown(rendered.reason, trace, "input-too-large"),
          inputReport: rendered.report,
        }
      const diagnostics = {
        inputReport: rendered.report,
        ...(input.inspectInput ? { inputDetails: rendered.details } : {}),
      }
      const failed = (reason: string, reasonCode: AiReasonCode): Evaluation => ({
        outcome: "failed",
        reason,
        reasonCode,
        trace,
        ...diagnostics,
      })
      const fromDecision = (decision: typeof DecisionRow.Type): Evaluation => ({
        outcome: decision.outcome,
        confidence: decision.confidence,
        reason: decision.reason,
        trace,
        cached: true,
        ...diagnostics,
        inputReport: decision.input_report ?? rendered.report,
        ...(decision.reason_code ? { reasonCode: decision.reason_code } : {}),
      })
      const evidenceHash = yield* sha256Hex(
        JSON.stringify({
          evidence: rendered.details.facts,
          budget: inputBudget,
          prompt: rendered.text,
          program: input.program,
          rule: input.rule ?? null,
          minimumConfidence: input.evaluator.minimumConfidence,
          provider: provider.identity,
          renderingVersion: rendered.report.version,
          decisionVersion: 3,
        }),
      )

      const stopped = () =>
        failed(
          "Evaluation stopped because newer work superseded it or repository access changed.",
          "provider-failed",
        )
      const [connection] = yield* sql<{
        generation_floor: string
      }>`SELECT generation_floor::text FROM github_repository WHERE repository_id=${input.repositoryId} AND connected`.pipe(
        wrap("connection"),
      )
      if (!connection) return stopped()
      const eligible = Effect.gen(function* () {
        const rows =
          yield* sql`SELECT 1 FROM github_repository WHERE repository_id=${input.repositoryId} AND connected AND generation_floor=${connection.generation_floor}`.pipe(
            wrap("connection"),
          )
        if (!rows.length) return false
        if (!(yield* retry.isCurrent)) return false
        const currentConsent = yield* consent.get(input.repositoryId).pipe(wrap("consent"))
        return (
          currentConsent.state === "enabled" &&
          currentConsent.provider === provider.identity.provider &&
          currentConsent.model === provider.identity.model
        )
      })
      const whileCurrent = <A, E extends { readonly message: string }, R>(
        effect: Effect.Effect<A, E, R>,
      ) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT repository_id FROM github_repository WHERE repository_id=${input.repositoryId} FOR NO KEY UPDATE`.pipe(
                wrap("connection"),
              )
              if (!(yield* eligible)) return Option.none<A>()
              return Option.some(yield* effect)
            }),
          )
          .pipe(wrap("connection"))
      if (!(yield* eligible)) return stopped()

      const requestHash = yield* sha256Hex(
        JSON.stringify([
          input.repositoryId,
          input.policyVersionId,
          input.number,
          evidenceHash,
          retry.claimKey ?? null,
        ]),
      )
      const readDecision = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        return yield* sql`
          SELECT outcome, confidence, reason, input_report, reason_code FROM labeling_ai_decision
          WHERE repository_id = ${input.repositoryId} AND policy_version_id = ${input.policyVersionId}
            AND number = ${input.number} AND evidence_hash = ${evidenceHash}
            AND created_at > ${new Date(now - cacheTtl * 1000)}
        `.pipe(Effect.flatMap(decodeDecisions), wrap("cache"))
      })
      const owner = crypto.randomUUID()
      const claim =
        yield* whileCurrent(sql`INSERT INTO labeling_ai_claim(request_hash,owner,repository_id,expires_at)
        VALUES (${requestHash},${owner},${input.repositoryId},CLOCK_TIMESTAMP()+INTERVAL '75 seconds')
        ON CONFLICT(request_hash) DO UPDATE SET owner=EXCLUDED.owner,expires_at=EXCLUDED.expires_at
        WHERE labeling_ai_claim.expires_at < CLOCK_TIMESTAMP() RETURNING owner`).pipe(wrap("claim"))
      if (Option.isNone(claim)) return stopped()
      if (!claim.value.length) {
        // Join a concurrent request by waiting for its decision, without a second paid call.
        for (let attempt = 0; attempt < 30; attempt++) {
          yield* Effect.sleep(Duration.seconds(2))
          if (!(yield* eligible)) return stopped()
          const decisions = yield* readDecision
          const decision = decisions[0]
          if (decision) {
            if (!(yield* eligible)) return stopped()
            return fromDecision(decision)
          }
        }
        return failed(
          "The concurrent evaluation did not finish; retry shortly.",
          "concurrent-timeout",
        )
      }
      return yield* Effect.gen(function* () {
        const cached = yield* readDecision
        if (!(yield* eligible)) return stopped()
        const hit = cached[0]
        if (hit !== undefined) return fromDecision(hit)

        const started = yield* Clock.currentTimeMillis
        let attempts = 0
        let previousDelay = 1000
        const ask = Effect.gen(function* () {
          const lease = yield* whileCurrent(acquireLease(input.repositoryId)).pipe(
            Effect.map(Option.flatten),
            wrap("lease"),
          )
          if (Option.isNone(lease))
            return Result.fail(
              new ClassifierError({
                operation: "lease",
                message:
                  "AI access is disabled or the evaluation budget is exhausted; retry later.",
              }),
            )
          attempts++
          return yield* provider
            .ask(rendered.text)
            .pipe(Effect.result, Effect.ensuring(releaseLease(lease.value)))
        })
        if (!(yield* eligible)) return stopped()
        let answer: Result.Result<ClassifierAnswer, ClassifierProviderError | ClassifierError> =
          yield* ask
        while (Result.isFailure(answer)) {
          const error = answer.failure
          if (error._tag === "ClassifierError") return failed(error.message, "budget-exhausted")
          if (!error.retryable)
            return failed(
              error.message + " Try the evaluation again after resolving the error.",
              "provider-failed",
            )
          const delay = Math.max(previousDelay * 2, error.retryAfterMs ?? 0)
          if (
            attempts >= 3 ||
            !Number.isFinite(delay) ||
            (yield* Clock.currentTimeMillis) - started + delay + 60000 > 240000
          )
            return failed(
              error.message +
                " Automatic retries exhausted after " +
                attempts +
                " attempts. Waiting for a new webhook event; tests can be run again.",
              "provider-failed",
            )
          if (!(yield* eligible)) return stopped()
          // Keep the claim valid while sleeping, without holding a consent lease or budget slot.
          yield* sql`UPDATE labeling_ai_claim SET expires_at=CLOCK_TIMESTAMP()+${delay + 75000} * INTERVAL '1 millisecond' WHERE request_hash=${requestHash} AND owner=${owner}`.pipe(
            wrap("claim"),
          )
          yield* retry.report(
            "AI request failed temporarily. Retrying attempt " +
              (attempts + 1) +
              " of 3 in " +
              Math.ceil(delay / 1000) +
              " seconds. Labels remain unchanged.",
          )
          previousDelay = delay
          yield* Effect.sleep(Duration.millis(delay))
          if (!(yield* eligible)) return stopped()
          answer = yield* ask
        }
        if (!(yield* eligible)) return stopped()
        const latency = (yield* Clock.currentTimeMillis) - started

        const outcome: Evaluation["outcome"] =
          answer.success.matches === null
            ? "unknown"
            : answer.success.matches &&
                answer.success.confidence >= input.evaluator.minimumConfidence
              ? "match"
              : "no-match"
        const reason =
          (attempts > 1 ? "Recovered after " + attempts + " attempts. " : "") +
          (answer.success.matches === null
            ? `Insufficient evidence: ${answer.success.reason}`
            : answer.success.confidence < input.evaluator.minimumConfidence
              ? `confidence ${answer.success.confidence.toFixed(2)} below ${input.evaluator.minimumConfidence}: ${answer.success.reason}`
              : answer.success.reason)
        const reasonCode =
          answer.success.matches === null
            ? ("insufficient-evidence" as const)
            : answer.success.confidence < input.evaluator.minimumConfidence
              ? ("low-confidence" as const)
              : undefined
        const completedAt = new Date(yield* Clock.currentTimeMillis)
        yield* whileCurrent(sql`
        INSERT INTO labeling_ai_decision
          (repository_id, policy_version_id, number, evidence_hash, provider, model, outcome, confidence, reason, latency_ms, input_report, reason_code, created_at)
        VALUES (${input.repositoryId}, ${input.policyVersionId}, ${input.number}, ${evidenceHash},
                ${provider.identity.provider}, ${provider.identity.model}, ${outcome},
                ${answer.success.confidence}, ${reason.slice(0, 1_000)}, ${Math.round(latency)}, ${JSON.stringify(rendered.report)}::jsonb, ${reasonCode ?? null}, ${completedAt})
        ON CONFLICT (repository_id, policy_version_id, number, evidence_hash) DO UPDATE SET
          outcome = EXCLUDED.outcome, confidence = EXCLUDED.confidence, reason = EXCLUDED.reason,
          latency_ms = EXCLUDED.latency_ms, input_report = EXCLUDED.input_report,
          reason_code = EXCLUDED.reason_code, created_at = EXCLUDED.created_at
        WHERE labeling_ai_decision.created_at <= EXCLUDED.created_at
      `).pipe(wrap("record"))
        return {
          outcome,
          reason,
          trace,
          confidence: answer.success.confidence,
          cached: false,
          ...diagnostics,
          ...(reasonCode ? { reasonCode } : {}),
        }
      }).pipe(
        Effect.ensuring(
          sql`DELETE FROM labeling_ai_claim WHERE request_hash=${requestHash} AND owner=${owner}`.pipe(
            Effect.ignore,
          ),
        ),
      )
    })

    return { classify }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

/** Present when the worker configured a provider; tests provide their own. */
export const classifyAi = (input: ClassifyInput) => {
  const gate = evaluateApplicability({
    program: input.program,
    snapshot: input.snapshot,
    resolve: input.resolve,
  })
  if (gate.outcome !== "match") return Effect.succeed(gate)
  return Effect.serviceOption(AiClassifier).pipe(
    Effect.flatMap((classifier) =>
      Option.isNone(classifier)
        ? Effect.succeed<Evaluation>({
            outcome: "failed",
            reason:
              "The AI classifier service is unavailable. Check the server's AI configuration.",
            reasonCode: "provider-unavailable",
            trace: gate.trace,
          })
        : classifier.value.classify(input).pipe(
            Effect.catch((error) =>
              Effect.logError("Classifier evaluation failed", error).pipe(
                Effect.as<Evaluation>({
                  outcome: "failed",
                  reason:
                    "The AI evaluation could not complete. Try again; if it persists, check server logs and database connectivity.",
                  reasonCode: "provider-failed",
                  trace: gate.trace,
                }),
              ),
            ),
          ),
    ),
  )
}
