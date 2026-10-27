import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * The chat sandbox's egress proxy (EFF-3017), the bot's security boundary.
 * Every HTTP and HTTPS request the container makes arrives here. The proxy
 * drops any `Authorization` header the container sent, then:
 *
 * - GitHub (`github.com`, `api.github.com`, `uploads.github.com`), for repos
 *   in an org the bot App is installed on: refuses what the policy refuses,
 *   puts the org's read token on git fetches, REST GETs and GraphQL queries,
 *   and its write token on everything else.
 * - `api.multica.ai`: adds the Janitor user's PAT, with no path filter.
 * - Everything else, other orgs on GitHub included, passes through with no
 *   credential.
 *
 * A refused request gets a 403 whose body says what was refused and why.
 */

/** A GitHub repository. Owner and name compare case-insensitively, as GitHub's do. */
export interface Repository {
  readonly owner: string
  readonly name: string
}

/** The two installation tokens minted for one org at acquire, both covering all its repos. */
export interface GitHubTokens {
  /** Read-only: git fetches, REST GETs and GraphQL queries. */
  readonly read: string
  /** Every other request the policy allows. */
  readonly write: string
}

/** What GitHub reports about a repository. */
export interface RepositoryInfo {
  readonly defaultBranch: string
  readonly private: boolean
}

/** Where a GraphQL node id points. */
export interface GitHubNode {
  readonly repository: Repository
  /** For a `Ref` node, its qualified name: `refs/heads/main`, `refs/tags/v1.0.0`. */
  readonly ref?: string | undefined
}

/** A GitHub lookup failed. The request it was for is refused. */
export class LookupFailed extends Schema.TaggedError<LookupFailed>()("LookupFailed", {
  reason: Schema.String,
}) {}

/**
 * The GitHub facts the policy reads, looked up with the owning org's read
 * token and cached for the acquire.
 */
export interface GitHubLookup {
  readonly repository: (repository: Repository) => Effect.Effect<RepositoryInfo, LookupFailed>
  /** Whether GitHub reports the branch as protected or covered by a ruleset. */
  readonly branchRuled: (
    repository: Repository,
    branch: string,
  ) => Effect.Effect<boolean, LookupFailed>
  /** Where a node id points, or `undefined` when no org's read token can see it. */
  readonly node: (id: string) => Effect.Effect<GitHubNode | undefined, LookupFailed>
}

/** One sandbox's egress: its credentials, its GitHub lookups and the way out. */
export interface ChatEgress {
  readonly sessionId: string
  readonly turnId: string
  /**
   * The current tokens for an org the bot App is installed on (Effect-TS,
   * Effectful-Tech), matched case-insensitively, or `undefined` for any
   * other owner.
   */
  readonly githubTokens: (owner: string) => Effect.Effect<GitHubTokens | undefined>
  /** `CHAT_MULTICA_TOKEN`, the Janitor user's PAT. */
  readonly multicaToken: string
  readonly github: GitHubLookup
  /** Sends the rewritten request on. */
  readonly upstream: (request: Request) => Effect.Effect<Response>
}

/**
 * Applies the egress policy to one container request and forwards it, or
 * answers 403. Forwarded requests don't follow redirects, so a redirect
 * target comes back through here and is checked again.
 */
export const handleChatEgress = (_request: Request, _egress: ChatEgress): Effect.Effect<Response> =>
  Effect.die("the chat egress proxy is not implemented yet (EFF-3017)")
