import { type GitHubRateLimitHeaders, type GitHubRequestPriority } from "@janitor/domain/GitHub/Api"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describeError } from "../SqlErrors.ts"

export class GitHubBudgetError extends Schema.TaggedError<GitHubBudgetError>()(
  "@janitor/cluster/GitHub/RateBudget/GitHubBudgetError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export interface BudgetKey {
  readonly scopeKey: string
  /** GitHub's `x-ratelimit-resource`, or "core" before the first response. */
  readonly resource: string
}

export interface AcquireRequest extends BudgetKey {
  readonly priority: GitHubRequestPriority
  readonly leaseToken: string
}

export type AcquireDecision =
  | { readonly _tag: "Granted"; readonly leaseToken: string }
  /** Do not call GitHub before `until`. */
  | { readonly _tag: "Wait"; readonly until: DateTime.Utc; readonly reason: string }

export interface RateObservation extends BudgetKey {
  readonly headers: GitHubRateLimitHeaders
  readonly observedAt: DateTime.Utc
  readonly leaseToken?: string | undefined
  readonly successful?: boolean | undefined
  readonly cooldown?:
    | { readonly until: DateTime.Utc; readonly kind: "retry-after" | "secondary" }
    | undefined
}

export interface CooldownRequest extends BudgetKey {
  readonly until: DateTime.Utc
  readonly kind: "retry-after" | "secondary"
}

/** Background scans preserve a single foreground reserve. */
export const priorityReserve = (priority: GitHubRequestPriority): number =>
  priority === "foreground" ? 0 : 200

export const LEASE_DURATION = Duration.seconds(30)
export const MAX_CONCURRENT_LEASES = 8

const DecisionRow = Schema.Struct({
  decision: Schema.Literals(["Granted", "Wait"]),
  until_at: Schema.NullOr(Schema.DateTimeUtcFromDate),
  reason: Schema.NullOr(Schema.String),
})

/**
 * Shared GitHub rate budget in Neon. Every active Durable Object and Worker
 * consults the same limits, cooldowns, and bounded leases, so concurrent
 * callers cannot collectively overrun one credential's allowance.
 */
export class GitHubBudget extends Context.Service<
  GitHubBudget,
  {
    readonly acquire: (request: AcquireRequest) => Effect.Effect<AcquireDecision, GitHubBudgetError>
    readonly release: (leaseToken: string) => Effect.Effect<void, GitHubBudgetError>
    readonly record: (observation: RateObservation) => Effect.Effect<void, GitHubBudgetError>
    readonly cooldown: (request: CooldownRequest) => Effect.Effect<void, GitHubBudgetError>
  }
>()("@janitor/cluster/GitHub/RateBudget/GitHubBudget", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const decodeDecision = Schema.decodeUnknownEffect(Schema.Array(DecisionRow))

    const wrap =
      (operation: string) =>
      <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
        Effect.mapError(
          effect,
          (error) => new GitHubBudgetError({ operation, message: describeError(error) }),
        )

    const acquire = Effect.fn("GitHubBudget.acquire")(function* (
      request: AcquireRequest,
    ): Generator<Effect.Effect<unknown, GitHubBudgetError>, AcquireDecision> {
      const now = DateTime.toDateUtc(yield* DateTime.now)
      const [decision] = yield* sql`SELECT * FROM acquire_github_rate_lease(
        ${request.scopeKey},${request.resource},${request.priority},${request.leaseToken},${now},
        ${priorityReserve(request.priority)},${request.priority === "background" ? MAX_CONCURRENT_LEASES - 2 : MAX_CONCURRENT_LEASES},${Duration.toSeconds(LEASE_DURATION)})`.pipe(
        Effect.flatMap(decodeDecision),
        wrap("acquire"),
      )
      if (!decision || (decision.decision === "Wait" && (!decision.until_at || !decision.reason)))
        return yield* new GitHubBudgetError({
          operation: "acquire",
          message: "Invalid budget decision",
        })
      return decision.decision === "Granted"
        ? { _tag: "Granted", leaseToken: request.leaseToken }
        : { _tag: "Wait", until: decision.until_at!, reason: decision.reason! }
    })

    const release = Effect.fn("GitHubBudget.release")(function* (leaseToken: string) {
      yield* sql`DELETE FROM github_rate_lease WHERE lease_token = ${leaseToken}`.pipe(
        wrap("release"),
      )
    })

    const record = Effect.fn("GitHubBudget.record")(function* (observation: RateObservation) {
      const headers = observation.headers
      const resetAt = Option.fromUndefinedOr(headers["x-ratelimit-reset"]).pipe(
        Option.map((seconds) => DateTime.makeUnsafe(seconds * 1000)),
      )
      const retryAfterUntil = Option.fromUndefinedOr(headers["retry-after"]).pipe(
        Option.map((seconds) =>
          DateTime.addDuration(observation.observedAt, Duration.seconds(seconds)),
        ),
      )
      const record = Effect.gen(function* () {
        yield* sql`
        WITH observed AS (INSERT INTO github_rate_budget ${sql.insert({
          scope_key: observation.scopeKey,
          resource: observation.resource,
          rate_limit: headers["x-ratelimit-limit"] ?? null,
          remaining: headers["x-ratelimit-remaining"] ?? null,
          used: headers["x-ratelimit-used"] ?? null,
          reset_at: Option.getOrNull(Option.map(resetAt, DateTime.toDateUtc)),
          retry_after_until: Option.getOrNull(Option.map(retryAfterUntil, DateTime.toDateUtc)),
          observed_at: DateTime.toDateUtc(observation.observedAt),
        })}
        ON CONFLICT (scope_key, resource) DO UPDATE SET
          rate_limit = COALESCE(EXCLUDED.rate_limit, github_rate_budget.rate_limit),
          remaining = CASE WHEN EXCLUDED.reset_at = github_rate_budget.reset_at
            THEN LEAST(EXCLUDED.remaining, github_rate_budget.remaining)
            ELSE COALESCE(EXCLUDED.remaining, github_rate_budget.remaining) END,
          used = COALESCE(EXCLUDED.used, github_rate_budget.used),
          reset_at = COALESCE(EXCLUDED.reset_at, github_rate_budget.reset_at),
          retry_after_until = GREATEST(EXCLUDED.retry_after_until, github_rate_budget.retry_after_until),
          observed_at = EXCLUDED.observed_at,
          secondary_strikes = CASE WHEN ${observation.successful === true} THEN 0 ELSE github_rate_budget.secondary_strikes END
        WHERE github_rate_budget.reset_at IS NULL OR EXCLUDED.reset_at IS NULL
          OR EXCLUDED.reset_at >= github_rate_budget.reset_at
        RETURNING 1)
        DELETE FROM github_rate_lease WHERE lease_token = ${observation.leaseToken ?? null}
      `
        if (observation.cooldown !== undefined)
          yield* cooldown({ ...observation, ...observation.cooldown })
      })
      yield* (observation.cooldown === undefined ? record : sql.withTransaction(record)).pipe(
        wrap("record"),
      )
    })

    const cooldown = Effect.fn("GitHubBudget.cooldown")(function* (request: CooldownRequest) {
      const column =
        request.kind === "retry-after" ? sql`retry_after_until` : sql`secondary_cooldown_until`
      const until = DateTime.toDateUtc(request.until)
      yield* sql`
        INSERT INTO github_rate_budget (scope_key, resource, ${column}, observed_at, secondary_strikes)
        VALUES (${request.scopeKey}, ${request.resource}, ${until}, CLOCK_TIMESTAMP(), ${request.kind === "secondary" ? 1 : 0})
        ON CONFLICT (scope_key, resource) DO UPDATE SET
          ${column} = GREATEST(github_rate_budget.${column}, EXCLUDED.${column},
            CASE WHEN ${request.kind === "secondary"} THEN CLOCK_TIMESTAMP() + make_interval(secs => LEAST(900, 60 * power(2, LEAST(github_rate_budget.secondary_strikes, 4)))) ELSE ${until} END),
          secondary_strikes = CASE WHEN ${request.kind === "secondary"} THEN LEAST(github_rate_budget.secondary_strikes + 1, 5) ELSE github_rate_budget.secondary_strikes END,
          observed_at = CLOCK_TIMESTAMP()
      `.pipe(wrap("cooldown"))
    })

    return { acquire, release, record, cooldown }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
