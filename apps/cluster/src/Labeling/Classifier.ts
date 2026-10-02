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
import {
  ClassifierProbabilities,
  type ClassifierEvaluator,
  type Evaluation,
  type Program,
} from "@janitor/domain/Labeling/Policy/Program"
import {
  classifierRequest,
  inputBytes,
  prepareClassifierInput,
  type ClassifierState,
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
import * as Hex from "effect/encoding/Hex"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Decision from "effect/ai/Decision"
import * as DecisionModel from "effect/ai/DecisionModel"
import * as AiError from "effect/ai/AiError"
import * as SqlClient from "effect/sql/SqlClient"
import { describeError } from "../SqlErrors.ts"

/**
 * Classifier evaluation (plan: "Classifier evaluator"). The provider is
 * one small interface so tests stub it; consent, leases, caching, batching
 * and the question contract live here and never in the provider.
 */

// PROVIDER

/** One rule's prepared question: its prompt and its slice of the decision state. */
export interface ClassifierQuery {
  readonly instructions: string
  readonly state: ClassifierState
}

/** The probabilities that a rule matches and that its evidence suffices to decide. */
export type ClassifierAnswer = ClassifierProbabilities

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

const PROVIDER_TIMEOUT = Duration.seconds(15)

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

// Provider payloads may echo evidence or credentials. Return guidance, never raw bodies.
const providerErrorMessage = (cause: unknown): string => {
  if (Cause.isTimeoutError(cause)) return "The AI provider timed out after 15 seconds. Try again."
  if (AiError.isAiError(cause)) {
    // OpenRouter answers 402 when the account or key has no credit left.
    if ("http" in cause.reason && cause.reason.http?.response?.status === 402)
      return "The OpenRouter credit or key limit is exhausted. Check the account's billing and key limits."
    switch (cause.reason._tag) {
      case "AuthenticationError":
        return "OpenRouter rejected authentication. Check the server's OPENROUTER_API_KEY and its permissions."
      case "InvalidRequestError":
      case "InvalidUserInputError":
        return "OpenRouter rejected the decision request. Check LABELING_AI_MODEL names a decision model such as typesafe/jev-1.13."
      case "QuotaExhaustedError":
        return "The OpenRouter credit or key limit is exhausted. Check the account's billing and key limits."
      case "RateLimitError":
        return "The OpenRouter rate limit was reached. Wait and try again."
      case "InvalidOutputError":
        return "The decision model returned an invalid answer. Try again."
      case "ContentPolicyError":
        return "OpenRouter rejected the content. Review the rule prompt and referenced facts."
      case "NetworkError":
        return "Could not reach OpenRouter. Check connectivity, then try again."
    }
  }
  return "The AI provider could not complete the request. Try again; if it persists, check OpenRouter's status and the server configuration."
}

export class ClassifierProvider extends Context.Service<
  ClassifierProvider,
  {
    readonly identity: ProviderIdentity
    /** Answers every query in one request, in query order. */
    readonly decide: (
      queries: ReadonlyArray<ClassifierQuery>,
    ) => Effect.Effect<ReadonlyArray<ClassifierAnswer>, ClassifierProviderError>
  }
>()("@janitor/cluster/Labeling/Classifier/ClassifierProvider") {
  /** Each rule asks two probability questions about its own slice of the state. */
  static readonly fromDecisionModel = (identity: ProviderIdentity) =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const model = yield* DecisionModel.DecisionModel
        return {
          identity,
          decide: (queries) => {
            if (queries.length === 0) return Effect.succeed([])
            const request = classifierRequest(queries)
            const definition = Decision.make({
              input: Schema.Json,
              decisions: Object.fromEntries(
                Object.entries(request.questions).map(([key, question]) => [
                  key,
                  Decision.probability(question),
                ]),
              ),
            })
            return model.decide(definition, { input: request.state }).pipe(
              Effect.timeout(PROVIDER_TIMEOUT),
              Effect.tap((response) =>
                Effect.logInfo("AI classifier usage").pipe(
                  Effect.annotateLogs({
                    provider: identity.provider,
                    model: identity.model,
                    rules: queries.length,
                    inputTokens: response.usage.inputTokens,
                  }),
                ),
              ),
              Effect.map((response) =>
                queries.map((_, i): ClassifierAnswer => ({
                  matches: response.answers[`r${i}_matches`]!.probability,
                  sufficient: response.answers[`r${i}_sufficient`]!.probability,
                })),
              ),
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
            )
          },
        }
      }),
    )

  /** What runs when no API key is configured: classification fails without sending data. */
  static readonly unavailable = Layer.succeed(this, {
    identity: { provider: "none", model: "none" },
    decide: () =>
      Effect.fail(
        new ClassifierProviderError({
          message: "No classifier provider is configured",
          cause: null,
        }),
      ),
  })
}

export const DEFAULT_MODEL = "typesafe/jev-1.13"

export interface ProviderConfig {
  readonly apiKey: Option.Option<Redacted.Redacted<string>>
  readonly model: string
}

/** Reads the OpenRouter key and decision model; an absent key means unavailable. */
export const providerConfig: Config.Wrap<ProviderConfig> = {
  apiKey: Config.option(Config.Redacted("OPENROUTER_API_KEY")),
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
  probabilities: Schema.NullOr(ClassifierProbabilities),
  outcome: Schema.Literals(["match", "no-match", "unknown"]),
  confidence: Schema.Finite,
  reason: Schema.String,
})

const sha256Hex = (text: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).pipe(
    Effect.map((digest) => Hex.encode(new Uint8Array(digest))),
  )

/** Below this probability that its evidence suffices, a rule's result is unknown. */
export const SUFFICIENT_EVIDENCE = 0.5

/**
 * Bytes of state and questions sent in one decision request. Jev accepts
 * 32k tokens of state plus the longest question; JSON evidence averages
 * three or more bytes per token, so this leaves room for tokenizer variance.
 */
export const MAX_REQUEST_BYTES = 80_000

/** Maps one rule's probabilities to its outcome and the reason recorded for it. */
export const decisionOutcome = (answer: ClassifierAnswer, minimumConfidence: number) => {
  const summary = `matches ${answer.matches.toFixed(2)} · evidence sufficient ${answer.sufficient.toFixed(2)}`
  if (answer.sufficient < SUFFICIENT_EVIDENCE)
    return {
      outcome: "unknown" as const,
      reasonCode: "insufficient-evidence" as const,
      reason: `Insufficient evidence: ${summary}`,
    }
  if (answer.matches >= minimumConfidence)
    return { outcome: "match" as const, reasonCode: undefined, reason: summary }
  if (answer.matches >= 0.5)
    return {
      outcome: "no-match" as const,
      reasonCode: "low-confidence" as const,
      reason: `confidence ${answer.matches.toFixed(2)} below ${minimumConfidence}: ${summary}`,
    }
  return { outcome: "no-match" as const, reasonCode: undefined, reason: summary }
}

/** Packs prepared rules, in order, into requests that stay under the byte limit. */
export const packRequests = <A>(
  items: ReadonlyArray<A>,
  size: (item: A) => number,
  limit = MAX_REQUEST_BYTES,
): ReadonlyArray<ReadonlyArray<A>> => {
  const requests: Array<Array<A>> = []
  let current: Array<A> = []
  let used = 0
  for (const item of items) {
    const bytes = size(item)
    if (current.length > 0 && used + bytes > limit) {
      requests.push(current)
      current = []
      used = 0
    }
    current.push(item)
    used += bytes
  }
  if (current.length > 0) requests.push(current)
  return requests
}

export const AiInputBudget = Context.Reference<number>("@janitor/AiInputBudget", {
  defaultValue: () => DEFAULT_INPUT_BYTES,
})

type Prepared = Extract<ReturnType<typeof prepareClassifierInput>, { readonly _tag: "Prepared" }>

/** A rule that needs an answer: everything its request, cache and record need. */
interface Pending {
  readonly index: number
  readonly input: ClassifyInput
  readonly trace: Evaluation["trace"]
  readonly rendered: Prepared
  readonly diagnostics: Pick<Evaluation, "inputReport" | "inputDetails">
  readonly evidenceHash: string
  readonly requestHash: string
}

/**
 * Evaluates classifier policies for one repository's snapshots. Each rule
 * passes applicability, consent and the decision cache on its own; the
 * rules that still need an answer share as few provider requests as the
 * size limit allows, each under one lease. Missing or insufficient evidence
 * is unknown; a likelihood below the minimum confidence is a non-match.
 * Operational failures preserve labels.
 */
export class AiClassifier extends Context.Service<
  AiClassifier,
  {
    readonly classify: (input: ClassifyInput) => Effect.Effect<Evaluation, ClassifierError>
    /** Results are in input order. */
    readonly classifyMany: (
      inputs: ReadonlyArray<ClassifyInput>,
    ) => Effect.Effect<ReadonlyArray<Evaluation>, ClassifierError>
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
    const failed = (pending: Pending, reason: string, reasonCode: AiReasonCode): Evaluation => ({
      outcome: "failed",
      reason,
      reasonCode,
      trace: pending.trace,
      ...pending.diagnostics,
    })
    const stopped = (pending: Pending) =>
      failed(
        pending,
        "Evaluation stopped because newer work superseded it or repository access changed.",
        "provider-failed",
      )
    const fromDecision = (pending: Pending, decision: typeof DecisionRow.Type): Evaluation => ({
      outcome: decision.outcome,
      confidence: decision.confidence,
      reason: decision.reason,
      trace: pending.trace,
      cached: true,
      ...pending.diagnostics,
      inputReport: decision.input_report ?? pending.rendered.report,
      ...(decision.reason_code ? { reasonCode: decision.reason_code } : {}),
      ...(decision.probabilities ? { probabilities: decision.probabilities } : {}),
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

    const classifyRepository = Effect.fnUntraced(function* (
      repositoryId: GitHubRepositoryDatabaseId,
      inputs: ReadonlyArray<ClassifyInput>,
    ) {
      const retry = yield* EvaluationRetry
      const results: Array<Evaluation | undefined> = inputs.map(() => undefined)
      const consentNow = yield* Effect.cached(consent.get(repositoryId).pipe(wrap("consent")))

      // Each rule settles on its own until it needs an answer from the provider.
      const pending: Array<Pending> = []
      for (const [index, input] of inputs.entries()) {
        // Applicability and target are decided purely; only the question needs a provider.
        const scoped = evaluateApplicability({
          program: input.program,
          snapshot: input.snapshot,
          resolve: input.resolve,
        })
        if (scoped.outcome !== "match") {
          results[index] = scoped
          continue
        }
        const trace = scoped.trace
        const missing = input.evaluator.evidence.filter(
          (fact) => input.snapshot.facts[fact] === undefined,
        )
        if (missing.length) {
          results[index] = unknown(
            "Evidence unavailable or incomplete: " + missing.join(", "),
            trace,
            "missing-evidence",
          )
          continue
        }
        const state = yield* consentNow
        if (state.state !== "enabled") {
          results[index] = unknown(
            `AI access is ${state.state}. Enable it in repository settings.`,
            trace,
            "access-disabled",
          )
          continue
        }
        if (provider.identity.provider === "none") {
          results[index] = {
            outcome: "failed",
            reason: "No AI provider is configured. Set OPENROUTER_API_KEY on the server.",
            reasonCode: "provider-unavailable",
            trace,
          }
          continue
        }
        if (
          state.provider !== provider.identity.provider ||
          state.model !== provider.identity.model
        ) {
          results[index] = unknown(
            "AI provider changed. Enable AI access again in repository settings.",
            trace,
            "access-disabled",
          )
          continue
        }
        const rendered = prepareClassifierInput(
          input.evaluator.prompt,
          input.evaluator.evidence,
          input.snapshot,
          inputBudget,
        )
        if (rendered._tag === "Rejected") {
          results[index] = {
            ...unknown(rendered.reason, trace, "input-too-large"),
            inputReport: rendered.report,
          }
          continue
        }
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
            decisionVersion: 4,
          }),
        )
        const requestHash = yield* sha256Hex(
          JSON.stringify([
            repositoryId,
            input.policyVersionId,
            input.number,
            evidenceHash,
            retry.claimKey ?? null,
          ]),
        )
        pending.push({
          index,
          input,
          trace,
          rendered,
          diagnostics: {
            inputReport: rendered.report,
            ...(input.inspectInput ? { inputDetails: rendered.details } : {}),
          },
          evidenceHash,
          requestHash,
        })
      }
      if (pending.length === 0) return results as ReadonlyArray<Evaluation>
      const stopAll = (rules: ReadonlyArray<Pending>) => {
        for (const rule of rules) results[rule.index] = stopped(rule)
        return results as ReadonlyArray<Evaluation>
      }

      const [connection] = yield* sql<{
        generation_floor: string
      }>`SELECT generation_floor::text FROM github_repository WHERE repository_id=${repositoryId} AND connected`.pipe(
        wrap("connection"),
      )
      if (!connection) return stopAll(pending)
      const eligible = Effect.gen(function* () {
        const rows =
          yield* sql`SELECT 1 FROM github_repository WHERE repository_id=${repositoryId} AND connected AND generation_floor=${connection.generation_floor}`.pipe(
            wrap("connection"),
          )
        if (!rows.length) return false
        if (!(yield* retry.isCurrent)) return false
        const currentConsent = yield* consent.get(repositoryId).pipe(wrap("consent"))
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
              yield* sql`SELECT repository_id FROM github_repository WHERE repository_id=${repositoryId} FOR NO KEY UPDATE`.pipe(
                wrap("connection"),
              )
              if (!(yield* eligible)) return Option.none<A>()
              return Option.some(yield* effect)
            }),
          )
          .pipe(wrap("connection"))
      if (!(yield* eligible)) return stopAll(pending)

      const readDecision = (rule: Pending) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          return yield* sql`
            SELECT outcome, confidence, reason, input_report, reason_code, probabilities FROM labeling_ai_decision
            WHERE repository_id = ${repositoryId} AND policy_version_id = ${rule.input.policyVersionId}
              AND number = ${rule.input.number} AND evidence_hash = ${rule.evidenceHash}
              AND created_at > ${new Date(now - cacheTtl * 1000)}
          `.pipe(Effect.flatMap(decodeDecisions), wrap("cache"))
        })

      // Join a concurrent request by waiting for its decision, without a second paid call.
      const join = Effect.fnUntraced(function* (rule: Pending) {
        for (let attempt = 0; attempt < 30; attempt++) {
          yield* Effect.sleep(Duration.seconds(2))
          if (!(yield* eligible)) return stopped(rule)
          const decision = (yield* readDecision(rule))[0]
          if (decision) {
            if (!(yield* eligible)) return stopped(rule)
            return fromDecision(rule, decision)
          }
        }
        return failed(
          rule,
          "The concurrent evaluation did not finish; retry shortly.",
          "concurrent-timeout",
        )
      })

      const owner = crypto.randomUUID()
      const extendClaims = (milliseconds: number) =>
        sql`UPDATE labeling_ai_claim SET expires_at=CLOCK_TIMESTAMP()+${milliseconds} * INTERVAL '1 millisecond' WHERE owner=${owner}`.pipe(
          wrap("claim"),
        )

      // One request for a batch of rules: one lease, shared retries, one record per rule.
      const decideRequest = Effect.fnUntraced(function* (rules: ReadonlyArray<Pending>) {
        const failAll = (reason: string, reasonCode: AiReasonCode) => {
          for (const rule of rules) results[rule.index] = failed(rule, reason, reasonCode)
        }
        yield* extendClaims(75000)
        const started = yield* Clock.currentTimeMillis
        let attempts = 0
        let previousDelay = 1000
        const ask = Effect.gen(function* () {
          const lease = yield* whileCurrent(acquireLease(repositoryId)).pipe(
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
            .decide(
              rules.map((rule) => ({
                instructions: rule.input.evaluator.prompt,
                state: rule.rendered.state,
              })),
            )
            .pipe(Effect.result, Effect.ensuring(releaseLease(lease.value)))
        })
        if (!(yield* eligible)) return void stopAll(rules)
        let answer: Result.Result<
          ReadonlyArray<ClassifierAnswer>,
          ClassifierProviderError | ClassifierError
        > = yield* ask
        while (Result.isFailure(answer)) {
          const error = answer.failure
          if (error._tag === "ClassifierError") return failAll(error.message, "budget-exhausted")
          if (!error.retryable)
            return failAll(
              error.message + " Try the evaluation again after resolving the error.",
              "provider-failed",
            )
          const delay = Math.max(previousDelay * 2, error.retryAfterMs ?? 0)
          if (
            attempts >= 3 ||
            !Number.isFinite(delay) ||
            (yield* Clock.currentTimeMillis) - started + delay + 60000 > 240000
          )
            return failAll(
              error.message +
                " Automatic retries exhausted after " +
                attempts +
                " attempts. Waiting for a new webhook event; tests can be run again.",
              "provider-failed",
            )
          if (!(yield* eligible)) return void stopAll(rules)
          // Keep the claims valid while sleeping, without holding a consent lease or budget slot.
          yield* extendClaims(delay + 75000)
          yield* retry.report(
            "AI request failed temporarily. Retrying attempt " +
              (attempts + 1) +
              " of 3 in " +
              Math.ceil(delay / 1000) +
              " seconds. Labels remain unchanged.",
          )
          previousDelay = delay
          yield* Effect.sleep(Duration.millis(delay))
          if (!(yield* eligible)) return void stopAll(rules)
          answer = yield* ask
        }
        if (!(yield* eligible)) return void stopAll(rules)
        const answers = answer.success
        if (answers.length !== rules.length)
          return failAll(
            "The decision model returned an invalid answer. Try again.",
            "provider-failed",
          )
        const latency = (yield* Clock.currentTimeMillis) - started
        const completedAt = new Date(yield* Clock.currentTimeMillis)
        for (const [i, rule] of rules.entries()) {
          const probabilities = answers[i]!
          const decision = decisionOutcome(probabilities, rule.input.evaluator.minimumConfidence)
          const reason =
            (attempts > 1 ? "Recovered after " + attempts + " attempts. " : "") + decision.reason
          yield* whileCurrent(sql`
          INSERT INTO labeling_ai_decision
            (repository_id, policy_version_id, number, evidence_hash, provider, model, outcome, confidence, reason, latency_ms, input_report, reason_code, probabilities, created_at)
          VALUES (${repositoryId}, ${rule.input.policyVersionId}, ${rule.input.number}, ${rule.evidenceHash},
                  ${provider.identity.provider}, ${provider.identity.model}, ${decision.outcome},
                  ${probabilities.matches}, ${reason.slice(0, 1_000)}, ${Math.round(latency)}, ${JSON.stringify(rule.rendered.report)}::jsonb, ${decision.reasonCode ?? null}, ${JSON.stringify(probabilities)}::jsonb, ${completedAt})
          ON CONFLICT (repository_id, policy_version_id, number, evidence_hash) DO UPDATE SET
            outcome = EXCLUDED.outcome, confidence = EXCLUDED.confidence, reason = EXCLUDED.reason,
            latency_ms = EXCLUDED.latency_ms, input_report = EXCLUDED.input_report,
            reason_code = EXCLUDED.reason_code, probabilities = EXCLUDED.probabilities,
            created_at = EXCLUDED.created_at
          WHERE labeling_ai_decision.created_at <= EXCLUDED.created_at
        `).pipe(wrap("record"))
          results[rule.index] = {
            outcome: decision.outcome,
            reason,
            trace: rule.trace,
            confidence: probabilities.matches,
            probabilities,
            cached: false,
            ...rule.diagnostics,
            ...(decision.reasonCode ? { reasonCode: decision.reasonCode } : {}),
          }
        }
      })

      return yield* Effect.gen(function* () {
        const owned: Array<Pending> = []
        const waiting: Array<Pending> = []
        for (const rule of pending) {
          const claim =
            yield* whileCurrent(sql`INSERT INTO labeling_ai_claim(request_hash,owner,repository_id,expires_at)
            VALUES (${rule.requestHash},${owner},${repositoryId},CLOCK_TIMESTAMP()+INTERVAL '75 seconds')
            ON CONFLICT(request_hash) DO UPDATE SET owner=EXCLUDED.owner,expires_at=EXCLUDED.expires_at
            WHERE labeling_ai_claim.expires_at < CLOCK_TIMESTAMP() RETURNING owner`).pipe(
              wrap("claim"),
            )
          if (Option.isNone(claim)) results[rule.index] = stopped(rule)
          else if (claim.value.length) owned.push(rule)
          else waiting.push(rule)
        }
        const misses: Array<Pending> = []
        for (const rule of owned) {
          const hit = (yield* readDecision(rule))[0]
          if (!(yield* eligible)) results[rule.index] = stopped(rule)
          else if (hit !== undefined) results[rule.index] = fromDecision(rule, hit)
          else misses.push(rule)
        }
        for (const request of packRequests(misses, (rule) => inputBytes(rule.rendered.text)))
          yield* decideRequest(request)
        yield* Effect.forEach(
          waiting,
          (rule) => Effect.map(join(rule), (evaluation) => (results[rule.index] = evaluation)),
          { concurrency: "unbounded", discard: true },
        )
        return results as ReadonlyArray<Evaluation>
      }).pipe(
        Effect.ensuring(
          sql`DELETE FROM labeling_ai_claim WHERE owner=${owner}`.pipe(Effect.ignore),
        ),
      )
    })

    const classifyMany = Effect.fn("AiClassifier.classifyMany")(function* (
      inputs: ReadonlyArray<ClassifyInput>,
    ) {
      const results: Array<Evaluation> = []
      const byRepository = new Map<GitHubRepositoryDatabaseId, Array<number>>()
      for (const [index, input] of inputs.entries())
        byRepository.set(input.repositoryId, [
          ...(byRepository.get(input.repositoryId) ?? []),
          index,
        ])
      for (const [repositoryId, indexes] of byRepository) {
        const evaluations = yield* classifyRepository(
          repositoryId,
          indexes.map((index) => inputs[index]!),
        )
        for (const [i, index] of indexes.entries()) results[index] = evaluations[i]!
      }
      return results as ReadonlyArray<Evaluation>
    })

    const classify = (input: ClassifyInput) =>
      Effect.map(classifyMany([input]), (evaluations) => evaluations[0]!)

    return { classify, classifyMany }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

/**
 * Evaluates classifier policies through the configured classifier, in input
 * order. Rules outside their applicability never reach it; tests may omit it.
 */
export const classifyAiMany = (inputs: ReadonlyArray<ClassifyInput>) =>
  Effect.gen(function* () {
    const results: Array<Evaluation> = []
    const applicable: Array<number> = []
    for (const [index, input] of inputs.entries()) {
      const gate = evaluateApplicability({
        program: input.program,
        snapshot: input.snapshot,
        resolve: input.resolve,
      })
      if (gate.outcome === "match") applicable.push(index)
      results[index] = gate
    }
    if (applicable.length === 0) return results as ReadonlyArray<Evaluation>
    const classifier = yield* Effect.serviceOption(AiClassifier)
    const failedAll = (reason: string, reasonCode: AiReasonCode) => {
      for (const index of applicable)
        results[index] = { outcome: "failed", reason, reasonCode, trace: results[index]!.trace }
    }
    if (Option.isNone(classifier)) {
      failedAll(
        "The AI classifier service is unavailable. Check the server's AI configuration.",
        "provider-unavailable",
      )
      return results as ReadonlyArray<Evaluation>
    }
    const evaluations = yield* classifier.value
      .classifyMany(applicable.map((index) => inputs[index]!))
      .pipe(
        Effect.catch((error) =>
          Effect.as(Effect.logError("Classifier evaluation failed", error), undefined),
        ),
      )
    if (evaluations === undefined)
      failedAll(
        "The AI evaluation could not complete. Try again; if it persists, check server logs and database connectivity.",
        "provider-failed",
      )
    else for (const [i, index] of applicable.entries()) results[index] = evaluations[i]!
    return results as ReadonlyArray<Evaluation>
  })

/** Present when the worker configured a provider; tests provide their own. */
export const classifyAi = (input: ClassifyInput) =>
  Effect.map(classifyAiMany([input]), (evaluations) => evaluations[0]!)
