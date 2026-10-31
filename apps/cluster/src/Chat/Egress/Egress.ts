import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  Kind,
  parse,
  valueFromASTUntyped,
  type DocumentNode,
  type FragmentDefinitionNode,
  type SelectionSetNode,
} from "graphql"

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
  /**
   * `CHAT_MULTICA_TOKEN`, the Janitor user's PAT, while the turn holds the
   * sandbox; `undefined` between turns or when unset, and then Multica gets
   * none.
   */
  readonly multicaToken: Effect.Effect<string | undefined>
  readonly github: GitHubLookup
  /** Sends the rewritten request on. */
  readonly upstream: (request: Request) => Effect.Effect<Response>
}

/** The orgs the bot App is installed on. Reads that name no owner use the first one's read token. */
export const BOT_ORGS: ReadonlyArray<string> = ["Effect-TS", "Effectful-Tech"]

const GITHUB_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "api.github.com",
  "uploads.github.com",
])
const MULTICA_HOST = "api.multica.ai"

/** Whether a request is for GitHub over HTTPS, the only traffic that can carry a GitHub token. */
export const isGitHubRequest = (url: URL): boolean =>
  url.protocol === "https:" && GITHUB_HOSTS.has(url.hostname)

/** A GitHub owner or repository path segment. Anything encoded doesn't match. */
const NAME = /^[A-Za-z0-9._-]+$/
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/** The longest ref-update section of a push the proxy reads before giving up. */
const MAX_PUSH_COMMANDS_BYTES = 1024 * 1024
/** The largest GraphQL body the proxy reads. */
const MAX_GRAPHQL_BYTES = 4 * 1024 * 1024
/** Bounds the work one GraphQL document can cost the parser. */
const MAX_GRAPHQL_TOKENS = 100_000

/** Mutations that write refs or commits directly. `mergeBranch` is GraphQL's `POST …/merges`. */
const REFUSED_MUTATIONS: ReadonlySet<string> = new Set([
  "createCommitOnBranch",
  "createRef",
  "updateRef",
  "updateRefs",
  "mergeBranch",
])

/** Why a request was refused, for the 403's body. */
class Refused extends Data.TaggedError("Refused")<{ readonly reason: string }> {}

const refuse = (reason: string) => new Refused({ reason })

/** Which token a request gets: an owner's read or write token, or none. */
type Credential = { readonly owner: string; readonly access: "read" | "write" } | undefined

const read = (owner: string): Credential => ({ owner, access: "read" })
const write = (owner: string): Credential => ({ owner, access: "write" })

/** What the policy decided for a request: its credential, and its body where the proxy read it. */
interface Decision {
  readonly credential: Credential
  readonly body?: BodyInit | undefined
}

const lower = (value: string) => value.toLowerCase()

const sameOwner = (a: string, b: string) => lower(a) === lower(b)

const isRead = (method: string) => method === "GET" || method === "HEAD"

const lookupRefused = (error: LookupFailed) =>
  refuse(`GitHub couldn't be asked about it (${error.reason})`)

/**
 * Whether a ref is protected: every tag and every ref outside
 * `refs/heads/`, the default branch, and any branch GitHub reports as
 * protected or covered by a ruleset. Effect-TS's private repos can't protect
 * branches, so only their default branch is guarded.
 */
const protectedReason = (github: GitHubLookup, repository: Repository, ref: string) =>
  Effect.gen(function* () {
    if (ref.startsWith("refs/tags/")) return "tags are protected"
    if (!ref.startsWith("refs/heads/")) return "only branches can be written"
    const branch = ref.slice("refs/heads/".length)
    const info = yield* github.repository(repository)
    if (branch === info.defaultBranch) {
      return "the default branch changes only through a pull request merge"
    }
    if (sameOwner(repository.owner, "Effect-TS") && info.private) return undefined
    return (yield* github.branchRuled(repository, branch))
      ? "the branch is protected or covered by a ruleset"
      : undefined
  }).pipe(Effect.mapError(lookupRefused))

const refuseProtected = (github: GitHubLookup, repository: Repository, ref: string) =>
  protectedReason(github, repository, ref).pipe(
    Effect.flatMap((reason) => (reason === undefined ? Effect.void : refuse(`${ref}: ${reason}`))),
  )

/** Reads a body up to `limit` bytes; past it, the request is refused. */
const readBody = (request: Request, limit: number) =>
  Effect.tryPromise({
    try: async () => {
      if (request.body === null) return new Uint8Array(0)
      const reader = request.body.getReader()
      const chunks: Array<Uint8Array> = []
      let size = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > limit) {
          await reader.cancel()
          return undefined
        }
        chunks.push(value)
      }
      return concat(chunks, size)
    },
    catch: () => refuse("its body couldn't be read"),
  }).pipe(
    Effect.flatMap((body) =>
      body === undefined ? refuse(`its body is over ${limit} bytes`) : Effect.succeed(body),
    ),
  )

const concat = (chunks: ReadonlyArray<Uint8Array>, size: number) => {
  const out = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

// git push

/** The refs a push updates, and its body as a stream that replays what was read. */
interface ParsedPush {
  readonly refs: ReadonlyArray<string>
  readonly body: ReadableStream<Uint8Array>
}

const decoder = new TextDecoder()

/**
 * Reads a `git-receive-pack` body up to the flush that ends its ref-update
 * lines (`old new ref`, the first carrying capabilities after a NUL), without
 * reading the pack after it. The returned body streams the bytes already read
 * and then the rest, unchanged.
 */
const parsePush = (request: Request) =>
  Effect.tryPromise({
    try: async (): Promise<ParsedPush | string> => {
      if (request.body === null) return "it has no body"
      const encoding = request.headers.get("content-encoding")
      if (encoding !== null && lower(encoding) !== "identity") {
        return "compressed push bodies aren't supported"
      }
      const reader = request.body.getReader()
      let buffer = new Uint8Array(0)
      let offset = 0
      const refs: Array<string> = []
      const fail = async (reason: string) => {
        await reader.cancel()
        return reason
      }
      while (true) {
        if (buffer.byteLength - offset >= 4) {
          const header = decoder.decode(buffer.subarray(offset, offset + 4))
          if (!/^[0-9a-fA-F]{4}$/.test(header)) return fail("its ref updates don't parse")
          const length = parseInt(header, 16)
          if (length === 0) {
            const read = buffer
            const body = new ReadableStream<Uint8Array>({
              start: (controller) => controller.enqueue(read),
              pull: async (controller) => {
                const { done, value } = await reader.read()
                if (done) controller.close()
                else controller.enqueue(value)
              },
              cancel: (reason) => reader.cancel(reason),
            })
            return { refs, body }
          }
          if (length < 4) return fail("its ref updates don't parse")
          if (buffer.byteLength - offset >= length) {
            const line = decoder
              .decode(buffer.subarray(offset + 4, offset + length))
              .split("\0")[0]!
              .replace(/\n$/, "")
            offset += length
            if (line.startsWith("shallow ")) continue
            if (line.startsWith("push-cert")) return fail("signed pushes aren't supported")
            const [old, next, ref, ...rest] = line.split(" ")
            if (
              old === undefined ||
              next === undefined ||
              ref === undefined ||
              rest.length > 0 ||
              !OID.test(old) ||
              !OID.test(next)
            ) {
              return fail("its ref updates don't parse")
            }
            refs.push(ref)
            continue
          }
        }
        if (buffer.byteLength > MAX_PUSH_COMMANDS_BYTES) return fail("its ref updates are too long")
        const { done, value } = await reader.read()
        if (done) return "it ended before its ref updates did"
        buffer = concat([buffer, value], buffer.byteLength + value.byteLength)
      }
    },
    catch: () => refuse("its body couldn't be read"),
  }).pipe(
    Effect.flatMap((parsed) =>
      typeof parsed === "string"
        ? refuse(`the push was refused: ${parsed}`)
        : Effect.succeed(parsed),
    ),
  )

// GraphQL

/** One root field of a mutation, with its arguments resolved against the variables. */
interface MutationField {
  readonly name: string
  readonly args: Record<string, unknown>
}

interface ParsedGraphQL {
  readonly mutations: ReadonlyArray<MutationField>
  /** Owners named by `repository(owner:)`, `organization(login:)` and the like, in order. */
  readonly owners: ReadonlyArray<string>
  /** Ids passed to `node(id:)` in queries. */
  readonly nodeIds: ReadonlyArray<string>
}

const OWNER_ARGUMENTS: Record<string, string> = {
  repository: "owner",
  organization: "login",
  repositoryOwner: "login",
  user: "login",
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Parses a GraphQL request body with graphql-js. Every operation counts,
 * whichever one `operationName` picks: a refused mutation anywhere refuses
 * the request. Fragments are followed, so a mutation can't hide in one.
 */
const parseGraphQL = (body: Uint8Array): ParsedGraphQL | string => {
  let request: unknown
  try {
    request = JSON.parse(decoder.decode(body))
  } catch {
    return "its body isn't JSON"
  }
  if (!isRecord(request) || typeof request.query !== "string") {
    return "its body isn't one GraphQL request"
  }
  const variables = isRecord(request.variables) ? request.variables : {}
  let document: DocumentNode
  try {
    document = parse(request.query, { noLocation: true, maxTokens: MAX_GRAPHQL_TOKENS })
  } catch {
    return "its query doesn't parse"
  }
  const fragments = new Map<string, FragmentDefinitionNode>()
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition)
    }
  }
  const mutations: Array<MutationField> = []
  const owners: Array<string> = []
  const nodeIds: Array<string> = []

  /** Visits every field under a selection set, following fragments once each. */
  const walk = (
    selectionSet: SelectionSetNode,
    visited: Set<string>,
    onField: (name: string, args: Record<string, unknown>, depth: number) => void,
    depth: number,
  ) => {
    for (const selection of selectionSet.selections) {
      switch (selection.kind) {
        case Kind.FIELD: {
          const args: Record<string, unknown> = {}
          for (const argument of selection.arguments ?? []) {
            args[argument.name.value] = valueFromASTUntyped(argument.value, variables)
          }
          onField(selection.name.value, args, depth)
          if (selection.selectionSet !== undefined) {
            walk(selection.selectionSet, visited, onField, depth + 1)
          }
          break
        }
        case Kind.INLINE_FRAGMENT:
          walk(selection.selectionSet, visited, onField, depth)
          break
        case Kind.FRAGMENT_SPREAD: {
          const name = selection.name.value
          const fragment = fragments.get(name)
          if (fragment !== undefined && !visited.has(name)) {
            visited.add(name)
            walk(fragment.selectionSet, visited, onField, depth)
          }
          break
        }
      }
    }
  }

  for (const definition of document.definitions) {
    if (definition.kind !== Kind.OPERATION_DEFINITION) continue
    const mutation = definition.operation === "mutation"
    walk(
      definition.selectionSet,
      new Set(),
      (name, args, depth) => {
        if (mutation && depth === 0) {
          mutations.push({ name, args })
          return
        }
        const ownerArgument = OWNER_ARGUMENTS[name]
        const owner = ownerArgument === undefined ? undefined : args[ownerArgument]
        if (typeof owner === "string") owners.push(owner)
        if (name === "node" && typeof args.id === "string") nodeIds.push(args.id)
      },
      0,
    )
  }
  return { mutations, owners, nodeIds }
}

/**
 * The node ids a mutation's arguments name: every `id` and `…Id` string,
 * nested inputs included, as in `updateIssue(input: { id })`.
 */
const nodeIdsIn = (value: unknown, into: Array<string> = []): Array<string> => {
  if (!isRecord(value)) return into
  for (const [key, field] of Object.entries(value)) {
    const named = key === "id" || (key !== "clientMutationId" && key.endsWith("Id"))
    if (named && typeof field === "string") {
      into.push(field)
    } else if (isRecord(field)) {
      nodeIdsIn(field, into)
    }
  }
  return into
}

/** The first of `owners` the bot holds tokens for, or `undefined`. */
const firstBotOwner = (egress: ChatEgress, owners: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    for (const owner of owners) {
      if ((yield* egress.githubTokens(owner)) !== undefined) return owner
    }
    return undefined
  })

const graphqlCredential = (
  request: Request,
  egress: ChatEgress,
): Effect.Effect<Decision, Refused> =>
  Effect.gen(function* () {
    const body = yield* readBody(request, MAX_GRAPHQL_BYTES)
    const parsed = parseGraphQL(body)
    if (typeof parsed === "string") {
      return yield* refuse(`the GraphQL request was refused: ${parsed}`)
    }
    const refused = parsed.mutations.find((field) => REFUSED_MUTATIONS.has(field.name))
    if (refused !== undefined) {
      return yield* refuse(`the ${refused.name} mutation is not allowed`)
    }
    const node = (id: string) => egress.github.node(id).pipe(Effect.mapError(lookupRefused))
    if (parsed.mutations.length === 0) {
      // A query only picks which read token to use, so a failed lookup isn't a refusal.
      const nodeOwners = yield* Effect.forEach(parsed.nodeIds, (id) =>
        node(id).pipe(
          Effect.map((found) => found?.repository.owner),
          Effect.orElseSucceed(() => undefined),
        ),
      )
      const owners = [
        ...parsed.owners,
        ...nodeOwners.filter((owner): owner is string => owner !== undefined),
      ]
      const owner = owners.length === 0 ? BOT_ORGS[0]! : yield* firstBotOwner(egress, owners)
      return { credential: owner === undefined ? undefined : read(owner), body }
    }

    // A mutation gets the write token of the one org its nodes are in.
    const found = yield* Effect.forEach(
      parsed.mutations.flatMap((field) => nodeIdsIn(field.args)),
      node,
    )
    const botOwners = new Map<string, string>()
    for (const entry of found) {
      if (entry === undefined) continue
      const owner = entry.repository.owner
      if ((yield* egress.githubTokens(owner)) !== undefined) botOwners.set(lower(owner), owner)
    }
    if (botOwners.size > 1) {
      return yield* refuse("one GraphQL request can't write to two orgs")
    }
    const [owner] = botOwners.values()
    if (owner === undefined) return { credential: undefined, body }
    for (const field of parsed.mutations) {
      if (field.name !== "deleteRef") continue
      const refId = isRecord(field.args.input) ? field.args.input.refId : undefined
      const ref = typeof refId === "string" ? yield* node(refId) : undefined
      if (ref?.ref === undefined) {
        return yield* refuse("deleteRef names a ref that couldn't be found")
      }
      yield* refuseProtected(egress.github, ref.repository, ref.ref)
    }
    return { credential: write(owner), body }
  })

// REST and git

/** The path's segments, percent-decoded, with empty ones dropped; `undefined` if it doesn't decode. */
const decodedSegments = (pathname: string) => {
  try {
    return decodeURIComponent(pathname)
      .split("/")
      .filter((segment) => segment.length > 0)
  } catch {
    return undefined
  }
}

/**
 * The REST policy for a request on one of the bot's repositories: GETs get
 * the read token, writes the write token, except the spec's denylist.
 */
const restCredential = (
  method: string,
  repository: Repository,
  rest: ReadonlyArray<string>,
  github: GitHubLookup,
): Effect.Effect<Credential, Refused> =>
  Effect.gen(function* () {
    if (isRead(method)) return read(repository.owner)
    const [first, second, third, ...more] = rest.map(lower)
    if (first === "merges" && rest.length === 1) {
      return yield* refuse("merging branches directly is not allowed; merge a pull request")
    }
    if (first === "merge-upstream" && rest.length === 1) {
      return yield* refuse("syncing a fork branch is not allowed")
    }
    if (first === "contents") {
      return yield* refuse("writing through the contents API is not allowed; push a branch")
    }
    if (first?.startsWith("releases")) return yield* refuse("releases are not allowed")
    if (first === "git" && second === "tags") return yield* refuse("tags are not allowed")
    if (first === "git" && (second === "refs" || second === "ref")) {
      if (method !== "DELETE" || second !== "refs" || third !== "heads" || more.length === 0) {
        return yield* refuse("git refs can't be written; only an unprotected branch can be deleted")
      }
      yield* refuseProtected(github, repository, `refs/heads/${rest.slice(3).join("/")}`)
    }
    return write(repository.owner)
  })

/**
 * `github.com`: git's smart HTTP on `/{owner}/{repo}(.git)/…`. Fetches get
 * the read token; pushes the write token, once every ref-update line has
 * been checked. Other GETs get the read token; anything else no credential.
 */
const gitCredential = (
  request: Request,
  url: URL,
  egress: ChatEgress,
): Effect.Effect<Decision, Refused> =>
  Effect.gen(function* () {
    const none = { credential: undefined }
    const [empty, owner, name, ...rest] = url.pathname.split("/")
    if (empty !== "" || owner === undefined || name === undefined) return none
    if (!NAME.test(owner) || !NAME.test(name)) return none
    if ((yield* egress.githubTokens(owner)) === undefined) return none
    const repository = { owner, name: name.replace(/\.git$/i, "") }
    const action = rest.join("/")
    const service = url.searchParams.getAll("service")
    if (action === "info/refs" && request.method === "GET" && service.length === 1) {
      if (service[0] === "git-upload-pack") return { credential: read(owner) }
      if (service[0] === "git-receive-pack") return { credential: write(owner) }
    }
    if (action === "git-upload-pack" && request.method === "POST") {
      return { credential: read(owner) }
    }
    if (action === "git-receive-pack" && request.method === "POST") {
      const push = yield* parsePush(request)
      for (const ref of push.refs) yield* refuseProtected(egress.github, repository, ref)
      return { credential: write(owner), body: push.body }
    }
    return isRead(request.method) ? { credential: read(owner) } : none
  })

/** `api.github.com` and `uploads.github.com`: GraphQL, repository routes, and the rest. */
const apiCredential = (
  request: Request,
  url: URL,
  egress: ChatEgress,
): Effect.Effect<Decision, Refused> =>
  Effect.gen(function* () {
    const none = { credential: undefined }
    if (url.hostname === "api.github.com" && url.pathname === "/graphql") {
      return request.method === "POST" ? yield* graphqlCredential(request, egress) : none
    }
    const segments = decodedSegments(url.pathname)
    if (segments === undefined) return yield* refuse("its path doesn't decode")
    const [first, owner, name, ...rest] = segments
    const root = lower(first ?? "")
    if (root === "repos" && owner !== undefined && name !== undefined) {
      if ((yield* egress.githubTokens(owner)) === undefined) return none
      return {
        credential: yield* restCredential(request.method, { owner, name }, rest, egress.github),
      }
    }
    // Org and user routes name their owner: the bot's orgs get their own read
    // token, and any other owner none. Writes there are outside the policy.
    if ((root === "orgs" || root === "users") && owner !== undefined) {
      if (!isRead(request.method) || (yield* egress.githubTokens(owner)) === undefined) return none
      return { credential: read(owner) }
    }
    // Reads that name no owner at all, such as search, use the first org's
    // read token. `/repositories/{id}` and other writes get none.
    return root !== "repositories" && isRead(request.method)
      ? { credential: read(BOT_ORGS[0]!) }
      : none
  })

/** Upstream answers worth chasing: auth failures, rate limits and server errors. */
const isUpstreamError = (status: number) =>
  status === 401 || status === 403 || status === 429 || status >= 500

/** The only response headers an upstream error's log line carries, under its annotation names. */
const UPSTREAM_ERROR_HEADERS = [
  ["requestId", "x-github-request-id"],
  ["retryAfter", "retry-after"],
  ["rateLimitRemaining", "x-ratelimit-remaining"],
  ["rateLimitReset", "x-ratelimit-reset"],
  ["rateLimitResource", "x-ratelimit-resource"],
] as const

/**
 * Logs an upstream error on a GitHub or Multica request with the credential
 * that was actually sent. Never the token, the body or the request headers,
 * and no query string.
 */
const logUpstreamError = (
  request: Request,
  url: URL,
  credential: "read" | "write" | "multica" | "none",
  response: Response,
) => {
  if (!isUpstreamError(response.status)) return Effect.void
  const annotations: Record<string, unknown> = {
    method: request.method,
    host: url.host,
    path: url.pathname,
    credential,
    status: response.status,
  }
  for (const [name, header] of UPSTREAM_ERROR_HEADERS) {
    const value = response.headers.get(header)
    if (value !== null) annotations[name] = value
  }
  return Effect.logWarning("Chat egress got an error from upstream").pipe(
    Effect.annotateLogs(annotations),
  )
}

const refusal = (request: Request, url: URL, reason: string) =>
  new Response(
    `janitor's egress proxy refused ${request.method} ${url.host}${url.pathname}: ${reason}\n`,
    { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } },
  )

/**
 * Applies the egress policy to one container request and forwards it, or
 * answers 403. Forwarded requests don't follow redirects, so a redirect
 * target comes back through here and is checked again.
 */
export const handleChatEgress = (request: Request, egress: ChatEgress): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const url = new URL(request.url)
    const headers = new Headers(request.headers)
    headers.delete("authorization")
    const forward = (body?: BodyInit) =>
      egress.upstream(
        body === undefined
          ? new Request(request, { headers, redirect: "manual" })
          : new Request(request.url, {
              method: request.method,
              headers,
              body,
              redirect: "manual",
              // Node wants this for a streamed body; workerd ignores it.
              ...({ duplex: "half" } as {}),
            }),
      )

    if (url.protocol === "https:" && url.hostname === MULTICA_HOST) {
      const token = yield* egress.multicaToken
      if (token !== undefined) headers.set("authorization", `Bearer ${token}`)
      const response = yield* forward()
      yield* logUpstreamError(request, url, token === undefined ? "none" : "multica", response)
      return response
    }
    if (!isGitHubRequest(url)) return yield* forward()

    const decided = yield* (
      url.hostname === "github.com"
        ? gitCredential(request, url, egress)
        : apiCredential(request, url, egress)
    ).pipe(
      Effect.catchTag("Refused", (refused) =>
        Effect.logWarning("Chat egress refused a request").pipe(
          Effect.annotateLogs({ method: request.method, host: url.host }),
          Effect.as(refused),
        ),
      ),
    )
    if (decided instanceof Refused) return refusal(request, url, decided.reason)
    const { credential, body } = decided
    let sent: "read" | "write" | "none" = "none"
    if (credential !== undefined) {
      const tokens = yield* egress.githubTokens(credential.owner)
      if (tokens !== undefined) {
        sent = credential.access
        const token = credential.access === "read" ? tokens.read : tokens.write
        headers.set(
          "authorization",
          url.hostname === "github.com"
            ? `Basic ${btoa(`x-access-token:${token}`)}`
            : `Bearer ${token}`,
        )
      }
    }
    const response = yield* forward(body)
    yield* logUpstreamError(request, url, sent, response)
    return response
  }).pipe(Effect.annotateLogs({ sessionId: egress.sessionId, turnId: egress.turnId }))
