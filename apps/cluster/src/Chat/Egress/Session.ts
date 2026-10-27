import { GITHUB_API_BASE_URL, GITHUB_REQUEST_HEADERS } from "@janitor/domain/GitHub/Api"
import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import type { BotApp, OrgTokens } from "./BotApp.ts"
import {
  BOT_ORGS,
  LookupFailed,
  type GitHubNode,
  type GitHubTokens,
  type Repository,
  type RepositoryInfo,
} from "./Egress.ts"

/**
 * One chat session's GitHub credentials and lookups, held by its workspace
 * Durable Object (EFF-3017). The egress entrypoint asks for them over the
 * workspace's `fetch`, with the control requests below; pack and API bodies
 * never pass through the object.
 *
 * - `start` (at acquire) revokes what an earlier turn left, clears the
 *   lookup cache and mints both tokens for every org.
 * - A token within `REMINT_MARGIN` of expiry is minted again on its next use,
 *   and the old one revoked.
 * - `stop` (at release) revokes every token. Between turns GitHub gets no
 *   credential.
 *
 * Tokens live only in memory: never in storage, logs or errors. If the
 * object restarts mid-turn, the turn's tokens are minted again on first use,
 * and the lost ones expire within the hour.
 */

/** The header that marks a workspace request as the egress entrypoint's, with its grant. */
export const EGRESS_CONTROL_HEADER = "x-janitor-chat-egress"

const RepositorySchema = Schema.Struct({ owner: Schema.String, name: Schema.String })

/** What the egress entrypoint asks its workspace. */
export const EgressQuery = Schema.Union([
  Schema.Struct({ op: Schema.Literal("tokens"), owner: Schema.String }),
  Schema.Struct({ op: Schema.Literal("repository"), repository: RepositorySchema }),
  Schema.Struct({
    op: Schema.Literal("branchRuled"),
    repository: RepositorySchema,
    branch: Schema.String,
  }),
  Schema.Struct({ op: Schema.Literal("node"), id: Schema.String }),
])
export type EgressQuery = typeof EgressQuery.Type

/** The workspace's answer: the value, or why a lookup failed. */
export type EgressAnswer = { readonly ok: unknown } | { readonly failed: string }

/** Re-mint a token this long before GitHub's one-hour expiry. */
const REMINT_MARGIN = Duration.minutes(10)
/** After a failed mint, wait this long before trying again for that org. */
const MINT_RETRY = Duration.seconds(30)
const MINT_TIMEOUT = Duration.seconds(30)
const LOOKUP_TIMEOUT = Duration.seconds(15)

const RepositoryResponse = Schema.Struct({ default_branch: Schema.String, private: Schema.Boolean })
const BranchResponse = Schema.Struct({ protected: Schema.Boolean })
const RulesResponse = Schema.Array(Schema.Unknown)
const MessageResponse = Schema.Struct({ message: Schema.String })

const NodeRepository = Schema.Struct({
  name: Schema.String,
  owner: Schema.Struct({ login: Schema.String }),
})
const NodeResponse = Schema.Struct({
  data: Schema.NullOr(
    Schema.Struct({
      node: Schema.NullOr(
        Schema.Struct({
          name: Schema.optional(Schema.String),
          prefix: Schema.optional(Schema.String),
          owner: Schema.optional(Schema.Struct({ login: Schema.String })),
          repository: Schema.optional(NodeRepository),
        }),
      ),
    }),
  ),
})

/** Where a node points: a repository itself, anything in one, or a ref. */
const NODE_QUERY = `query($id: ID!) {
  node(id: $id) {
    ... on Repository { name owner { login } }
    ... on RepositoryNode { repository { name owner { login } } }
    ... on Ref { name prefix repository { name owner { login } } }
    ... on Label { repository { name owner { login } } }
    ... on Milestone { repository { name owner { login } } }
    ... on Commit { repository { name owner { login } } }
  }
}`

const encodePath = (value: string) => value.split("/").map(encodeURIComponent).join("/")

const repositoryPath = (repository: Repository) =>
  `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`

const botOrg = (owner: string) => BOT_ORGS.find((org) => org.toLowerCase() === owner.toLowerCase())

export const makeEgressSession = Effect.fnUntraced(function* (app: BotApp | undefined) {
  const lock = yield* Semaphore.make(1)
  /** The grant whose turn holds the sandbox, or `undefined` between turns. */
  let active: number | undefined
  /** Tokens by org; `null` where the App isn't installed. */
  const minted = new Map<string, OrgTokens | null>()
  const retryAfter = new Map<string, number>()
  const repositories = new Map<string, RepositoryInfo>()
  const branches = new Map<string, boolean>()
  const nodes = new Map<string, GitHubNode | null>()

  const revoke = (tokens: OrgTokens | null | undefined) =>
    app === undefined || tokens == null
      ? Effect.void
      : Effect.forEach([tokens.read, tokens.write], app.revoke, { discard: true }).pipe(
          Effect.catch(() => Effect.logWarning("Could not revoke a chat sandbox token")),
        )

  const revokeAll = Effect.suspend(() => {
    const held = [...minted.values()]
    minted.clear()
    retryAfter.clear()
    return Effect.forEach(held, revoke, { discard: true })
  })

  /** The org's current tokens, minting them when missing or near expiry. */
  const orgTokens = (org: string) =>
    Effect.gen(function* () {
      if (app === undefined) return undefined
      const key = org.toLowerCase()
      const now = yield* Clock.currentTimeMillis
      const held = minted.get(key)
      if (held === null) return undefined
      if (held !== undefined && held.expiresAt - now > Duration.toMillis(REMINT_MARGIN)) {
        return held
      }
      const wait = retryAfter.get(key)
      if (wait !== undefined && now < wait) return held
      const fresh = yield* app.mint(org).pipe(
        Effect.timeoutOrElse({
          duration: MINT_TIMEOUT,
          orElse: () => Effect.fail({ reason: "minting timed out" }),
        }),
        Effect.catch((error) =>
          Effect.logWarning("Could not mint chat sandbox tokens", error.reason).pipe(
            Effect.annotateLogs({ org }),
            Effect.andThen(
              Effect.sync(() => {
                retryAfter.set(key, now + Duration.toMillis(MINT_RETRY))
              }),
            ),
            Effect.as("failed" as const),
          ),
        ),
        Effect.uninterruptible,
      )
      if (fresh === "failed") return held
      minted.set(key, fresh ?? null)
      retryAfter.delete(key)
      yield* revoke(held)
      return fresh
    }).pipe(Semaphore.withPermits(lock, 1))

  /** The tokens a request from `generation` may use for `owner`. */
  const tokens = (owner: string, generation: number) =>
    Effect.gen(function* () {
      const org = botOrg(owner)
      if (org === undefined || active === undefined || generation !== active) return undefined
      const held = yield* orgTokens(org)
      return held === undefined
        ? undefined
        : ({ read: held.read, write: held.write } as GitHubTokens)
    })

  /** A GitHub request with a read token, answered as status and JSON. */
  const github = (token: string, path: string, init?: { method: string; body: string }) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${GITHUB_API_BASE_URL}${path}`, {
          ...init,
          headers: { ...GITHUB_REQUEST_HEADERS, authorization: `Bearer ${token}` },
        })
        return { status: response.status, body: (await response.json()) as unknown }
      },
      catch: () => new LookupFailed({ reason: "GitHub couldn't be reached" }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: LOOKUP_TIMEOUT,
        orElse: () => Effect.fail(new LookupFailed({ reason: "GitHub didn't answer in time" })),
      }),
    )

  const decode =
    <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
    (body: unknown) =>
      Schema.decodeUnknownEffect(schema)(body).pipe(
        Effect.mapError(() => new LookupFailed({ reason: "GitHub's answer was unreadable" })),
      )

  const readToken = (owner: string, generation: number) =>
    tokens(owner, generation).pipe(
      Effect.flatMap((held) =>
        held === undefined
          ? Effect.fail(new LookupFailed({ reason: `no token for ${owner}` }))
          : Effect.succeed(held.read),
      ),
    )

  const answered = (status: number) => new LookupFailed({ reason: `GitHub answered ${status}` })

  const repository = (target: Repository, generation: number) =>
    Effect.gen(function* () {
      const key = `${target.owner}/${target.name}`.toLowerCase()
      const cached = repositories.get(key)
      if (cached !== undefined) return cached
      const token = yield* readToken(target.owner, generation)
      const response = yield* github(token, repositoryPath(target))
      if (response.status !== 200) return yield* answered(response.status)
      const body = yield* decode(RepositoryResponse)(response.body)
      const info = { defaultBranch: body.default_branch, private: body.private }
      repositories.set(key, info)
      return info
    })

  /**
   * GitHub's verdict on a branch: classic protection from the branches API,
   * rulesets from the rules API. A branch that doesn't exist yet has no
   * classic protection, though a ruleset can still cover its name.
   */
  const branchRuled = (target: Repository, branch: string, generation: number) =>
    Effect.gen(function* () {
      const key = `${target.owner}/${target.name}#${branch}`.toLowerCase()
      const cached = branches.get(key)
      if (cached !== undefined) return cached
      const token = yield* readToken(target.owner, generation)
      const path = repositoryPath(target)
      const [classic, rules] = yield* Effect.all(
        [
          github(token, `${path}/branches/${encodePath(branch)}`),
          github(token, `${path}/rules/branches/${encodePath(branch)}`),
        ],
        { concurrency: 2 },
      )
      let ruled: boolean
      if (classic.status === 404) ruled = false
      else if (classic.status === 200)
        ruled = (yield* decode(BranchResponse)(classic.body)).protected
      else return yield* answered(classic.status)
      if (!ruled) {
        if (rules.status === 200) ruled = (yield* decode(RulesResponse)(rules.body)).length > 0
        else if (!(yield* noRulesets(rules))) return yield* answered(rules.status)
      }
      branches.set(key, ruled)
      return ruled
    })

  /** A rules answer that means the repository can't have rulesets: none found, or a plan without them. */
  const noRulesets = (response: { readonly status: number; readonly body: unknown }) =>
    response.status === 404
      ? Effect.succeed(true)
      : response.status === 403
        ? Schema.decodeUnknownEffect(MessageResponse)(response.body).pipe(
            Effect.map(({ message }) => message.includes("Upgrade to GitHub Pro")),
            Effect.orElseSucceed(() => false),
          )
        : Effect.succeed(false)

  /** Asks each org's read token in turn, since a private node is visible to its own org's only. */
  const node = (id: string, generation: number) =>
    Effect.gen(function* () {
      const cached = nodes.get(id)
      if (cached !== undefined) return cached ?? undefined
      let found: GitHubNode | undefined
      for (const org of BOT_ORGS) {
        const held = yield* tokens(org, generation)
        if (held === undefined) continue
        const response = yield* github(held.read, "/graphql", {
          method: "POST",
          body: JSON.stringify({ query: NODE_QUERY, variables: { id } }),
        })
        if (response.status !== 200) return yield* answered(response.status)
        const value = (yield* decode(NodeResponse)(response.body)).data?.node
        const repository =
          value?.repository ??
          (value?.owner !== undefined && value.name !== undefined
            ? { name: value.name, owner: value.owner }
            : undefined)
        if (value == null || repository === undefined) continue
        found = {
          repository: { owner: repository.owner.login, name: repository.name },
          ...(value.repository !== undefined &&
          value.prefix !== undefined &&
          value.name !== undefined
            ? { ref: `${value.prefix}${value.name}` }
            : {}),
        }
        break
      }
      nodes.set(id, found ?? null)
      return found
    })

  /** A turn acquired the sandbox: earlier tokens go, and this turn's are minted. */
  const start = (generation: number) =>
    Effect.gen(function* () {
      yield* revokeAll
      repositories.clear()
      branches.clear()
      nodes.clear()
      active = generation
      yield* Effect.forEach(BOT_ORGS, orgTokens, { concurrency: "unbounded", discard: true })
    })

  /** The turn holding `generation` ended: its tokens are revoked. */
  const stop = (generation: number) =>
    Effect.suspend(() => {
      if (active === undefined || generation < active) return Effect.void
      active = undefined
      return revokeAll
    })

  /** Answers one control request from the egress entrypoint. */
  const answer = (query: EgressQuery, generation: number): Effect.Effect<EgressAnswer> => {
    const run = (): Effect.Effect<unknown, LookupFailed> => {
      switch (query.op) {
        case "tokens":
          return tokens(query.owner, generation).pipe(Effect.map((held) => held ?? null))
        case "repository":
          return repository(query.repository, generation)
        case "branchRuled":
          return branchRuled(query.repository, query.branch, generation)
        case "node":
          return node(query.id, generation).pipe(Effect.map((found) => found ?? null))
      }
    }
    return run().pipe(
      Effect.map((ok): EgressAnswer => ({ ok })),
      Effect.catch((error) => Effect.succeed({ failed: error.reason })),
    )
  }

  /** Restores the active grant after the object restarted, without minting until asked. */
  const resume = (generation: number) =>
    Effect.sync(() => {
      active = generation
    })

  return { start, stop, resume, answer } as const
})

export type EgressSession = Effect.Success<ReturnType<typeof makeEgressSession>>

/** What the workspace registers the egress entrypoint with, once per acquire. */
export interface ChatEgressProps {
  readonly sessionId: string
  /** The grant the turn holds; the workspace hands tokens only to its current one. */
  readonly generation: number
  readonly turnId: string
  /** `CHAT_MULTICA_TOKEN`, or empty when unset. */
  readonly multicaToken: string
}
