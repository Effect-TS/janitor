import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
  handleChatEgress,
  LookupFailed,
  type ChatEgress,
  type GitHubNode,
  type GitHubTokens,
  type Repository,
  type RepositoryInfo,
} from "../../../src/Chat/Egress/Egress.ts"

const TOKENS: Record<string, GitHubTokens> = {
  "effect-ts": { read: "ghs_read_effect", write: "ghs_write_effect" },
  "effectful-tech": { read: "ghs_read_effectful", write: "ghs_write_effectful" },
}
const MULTICA_TOKEN = "mul_janitor"

/**
 * What GitHub reports. `Effect-TS/secret` is a private repo on Effect-TS's
 * plan, which can't protect branches: GitHub refuses to say whether one is.
 */
const REPOSITORIES: Record<string, RepositoryInfo> = {
  "effect-ts/effect": { defaultBranch: "main", private: false },
  "effect-ts/secret": { defaultBranch: "main", private: true },
  "effectful-tech/clanka": { defaultBranch: "master", private: true },
}
/** `next` has classic branch protection, `release/4.x` a ruleset. */
const RULED: Record<string, ReadonlyArray<string>> = {
  "effect-ts/effect": ["next", "release/4.x"],
  "effectful-tech/clanka": ["production"],
}
const effect = { owner: "Effect-TS", name: "effect" }
const clanka = { owner: "Effectful-Tech", name: "clanka" }
const NODES: Record<string, GitHubNode> = {
  R_effect: { repository: effect },
  PR_effect: { repository: effect },
  I_effect: { repository: effect },
  PR_clanka: { repository: clanka },
  REF_feature: { repository: effect, ref: "refs/heads/feature" },
  REF_main: { repository: effect, ref: "refs/heads/main" },
  REF_next: { repository: effect, ref: "refs/heads/next" },
  REF_tag: { repository: effect, ref: "refs/tags/v4.0.0" },
}

const key = (repository: Repository) => `${repository.owner}/${repository.name}`.toLowerCase()

/**
 * A sandbox's egress against the GitHub above. Every forwarded request is
 * recorded and answered 200.
 */
const makeEgress = (forwarded: Array<Request>): ChatEgress => ({
  sessionId: "slack/T1/C1/1730000000.000100",
  turnId: "turn-1",
  githubTokens: (owner) => Effect.succeed(TOKENS[owner.toLowerCase()]),
  multicaToken: Effect.succeed(MULTICA_TOKEN),
  github: {
    repository: (repository) => {
      const info = REPOSITORIES[key(repository)]
      return info === undefined
        ? Effect.fail(new LookupFailed({ reason: "Not Found" }))
        : Effect.succeed(info)
    },
    branchRuled: (repository, branch) => {
      if (key(repository) === "effect-ts/secret") {
        return Effect.fail(
          new LookupFailed({ reason: "Upgrade to GitHub Pro or make this repository public" }),
        )
      }
      const ruled = RULED[key(repository)]
      return ruled === undefined
        ? Effect.fail(new LookupFailed({ reason: "Not Found" }))
        : Effect.succeed(ruled.includes(branch))
    },
    node: (id) => Effect.succeed(NODES[id]),
  },
  upstream: (request) =>
    Effect.sync(() => {
      forwarded.push(request)
      return new Response("upstream")
    }),
})

interface Row {
  readonly name: string
  readonly method: string
  readonly url: string
  readonly body?: Uint8Array<ArrayBuffer>
  readonly expected: string
}

const encoder = new TextEncoder()

const ZERO = "0".repeat(40)
const OLD = "a".repeat(40)
const NEW = "b".repeat(40)

const pktLine = (payload: string) =>
  `${(payload.length + 4).toString(16).padStart(4, "0")}${payload}`

/** A `git-receive-pack` body: the ref-update lines, a flush, then a pack. */
const receivePack = (updates: ReadonlyArray<readonly [old: string, next: string, ref: string]>) =>
  encoder.encode(
    updates
      .map(([old, next, ref], index) =>
        pktLine(`${old} ${next} ${ref}${index === 0 ? "\0report-status side-band-64k" : ""}\n`),
      )
      .join("") + "0000PACK\0\0\0\x02\0\0\0\0",
  )

const create = (ref: string) => [ZERO, NEW, ref] as const
const update = (ref: string) => [OLD, NEW, ref] as const
const remove = (ref: string) => [OLD, ZERO, ref] as const

const fetchRows = (repo: string, expected: string): ReadonlyArray<Row> => [
  {
    name: "fetch refs",
    method: "GET",
    url: `https://github.com/${repo}.git/info/refs?service=git-upload-pack`,
    expected,
  },
  {
    name: "fetch pack",
    method: "POST",
    url: `https://github.com/${repo}.git/git-upload-pack`,
    body: encoder.encode("0000"),
    expected,
  },
]

const push = (
  name: string,
  repo: string,
  updates: ReadonlyArray<readonly [string, string, string]>,
  expected: string,
): Row => ({
  name,
  method: "POST",
  url: `https://github.com/${repo}/git-receive-pack`,
  body: receivePack(updates),
  expected,
})

const rest = (method: string, path: string, expected: string, body?: unknown): Row => ({
  name: "rest",
  method,
  url: `https://api.github.com${path}`,
  ...(body === undefined ? {} : { body: encoder.encode(JSON.stringify(body)) }),
  expected,
})

const graphql = (
  name: string,
  request: {
    readonly query: string
    readonly variables?: Record<string, unknown>
    readonly operationName?: string
  },
  expected: string,
): Row => ({
  name: `graphql ${name}`,
  method: "POST",
  url: "https://api.github.com/graphql",
  body: encoder.encode(JSON.stringify(request)),
  expected,
})

const E = "/repos/Effect-TS/effect"

const table: ReadonlyArray<Row> = [
  // git fetches: the read token
  ...fetchRows("Effect-TS/effect", "read:Effect-TS"),
  ...fetchRows("Effectful-Tech/clanka", "read:Effectful-Tech"),
  ...fetchRows("someone/else", "anonymous"),

  // git pushes: the write token, unless a ref-update line touches a protected ref
  {
    name: "push refs",
    method: "GET",
    url: "https://github.com/Effect-TS/effect.git/info/refs?service=git-receive-pack",
    expected: "write:Effect-TS",
  },
  push(
    "create a branch",
    "Effect-TS/effect.git",
    [create("refs/heads/feature")],
    "write:Effect-TS",
  ),
  push(
    "update a branch",
    "Effect-TS/effect.git",
    [update("refs/heads/feature")],
    "write:Effect-TS",
  ),
  push(
    "delete a branch",
    "Effect-TS/effect.git",
    [remove("refs/heads/feature")],
    "write:Effect-TS",
  ),
  push("update the default branch", "Effect-TS/effect.git", [update("refs/heads/main")], "refused"),
  push("delete the default branch", "Effect-TS/effect.git", [remove("refs/heads/main")], "refused"),
  push("update a protected branch", "Effect-TS/effect.git", [update("refs/heads/next")], "refused"),
  push(
    "update a ruleset branch",
    "Effect-TS/effect.git",
    [update("refs/heads/release/4.x")],
    "refused",
  ),
  push("create a tag", "Effect-TS/effect.git", [create("refs/tags/v4.0.0")], "refused"),
  push("delete a tag", "Effect-TS/effect.git", [remove("refs/tags/v4.0.0")], "refused"),
  push(
    "a protected ref, then a branch",
    "Effect-TS/effect.git",
    [update("refs/heads/main"), create("refs/heads/feature")],
    "refused",
  ),
  push(
    "a branch, then a tag",
    "Effect-TS/effect.git",
    [create("refs/heads/feature"), create("refs/tags/v4.0.0")],
    "refused",
  ),
  push(
    "the default branch, case-changed repo",
    "effect-ts/EFFECT.git",
    [update("refs/heads/main")],
    "refused",
  ),
  push("the default branch, no .git", "Effect-TS/effect", [update("refs/heads/main")], "refused"),
  push(
    "a branch, Effect-TS private",
    "Effect-TS/secret.git",
    [update("refs/heads/feature")],
    "write:Effect-TS",
  ),
  push(
    "the default branch, Effect-TS private",
    "Effect-TS/secret.git",
    [update("refs/heads/main")],
    "refused",
  ),
  push(
    "a branch, Effectful-Tech",
    "Effectful-Tech/clanka.git",
    [update("refs/heads/feature")],
    "write:Effectful-Tech",
  ),
  push(
    "the default branch, Effectful-Tech",
    "Effectful-Tech/clanka.git",
    [update("refs/heads/master")],
    "refused",
  ),
  push(
    "a protected branch, Effectful-Tech",
    "Effectful-Tech/clanka.git",
    [update("refs/heads/production")],
    "refused",
  ),
  push("another org", "someone/else.git", [update("refs/heads/main")], "anonymous"),
  {
    name: "a push that doesn't parse",
    method: "POST",
    url: "https://github.com/Effect-TS/effect.git/git-receive-pack",
    body: encoder.encode("zzzz not a pkt-line"),
    expected: "refused",
  },

  // REST reads: the read token
  rest("GET", `${E}/pulls`, "read:Effect-TS"),
  rest("GET", "/repos/effect-ts/EFFECT/pulls", "read:Effect-TS"),
  rest("GET", "/repos/Effectful-Tech/clanka/issues", "read:Effectful-Tech"),
  rest("GET", `${E}/releases`, "read:Effect-TS"),
  rest("GET", "/repos/someone/else/pulls", "anonymous"),

  // REST writes the policy allows: the write token
  rest("POST", `${E}/pulls`, "write:Effect-TS", { title: "t", head: "feature", base: "main" }),
  rest("PATCH", `${E}/pulls/1`, "write:Effect-TS", { state: "closed" }),
  rest("PUT", `${E}/pulls/1/merge`, "write:Effect-TS", { merge_method: "squash" }),
  rest("POST", `${E}/pulls/1/reviews`, "write:Effect-TS", { event: "APPROVE" }),
  rest("POST", `${E}/issues`, "write:Effect-TS", { title: "t" }),
  rest("PATCH", `${E}/issues/2`, "write:Effect-TS", { state: "closed" }),
  rest("POST", `${E}/issues/2/comments`, "write:Effect-TS", { body: "hi" }),
  rest("POST", `${E}/issues/2/labels`, "write:Effect-TS", { labels: ["bug"] }),
  rest("DELETE", `${E}/git/refs/heads/feature`, "write:Effect-TS"),
  rest("DELETE", "/repos/Effect-TS/secret/git/refs/heads/feature", "write:Effect-TS"),
  rest("POST", "/repos/Effectful-Tech/clanka/issues/2/comments", "write:Effectful-Tech", {
    body: "hi",
  }),
  rest("POST", "/repos/someone/else/issues", "anonymous", { title: "t" }),
  // No owner in the path, so no credential to misuse.
  rest("PUT", "/repositories/1/contents/README.md", "anonymous", { message: "m", content: "" }),

  // REST writes the policy refuses
  rest("POST", `${E}/merges`, "refused", { base: "main", head: "feature" }),
  rest("POST", `${E}/merge-upstream`, "refused", { branch: "main" }),
  rest("PUT", `${E}/contents/README.md`, "refused", { message: "m", content: "" }),
  rest("DELETE", `${E}/contents/README.md`, "refused", { message: "m", sha: OLD }),
  rest("PUT", "/repos/effect-ts/Effect/contents/README.md", "refused", {
    message: "m",
    content: "",
  }),
  rest("POST", `${E}/git/refs`, "refused", { ref: "refs/heads/x", sha: NEW }),
  rest("PATCH", `${E}/git/refs/heads/feature`, "refused", { sha: NEW, force: true }),
  rest("DELETE", `${E}/git/refs/heads/main`, "refused"),
  rest("DELETE", `${E}/git/refs/heads/next`, "refused"),
  rest("DELETE", `${E}/git/refs/heads/release/4.x`, "refused"),
  rest("DELETE", `${E}/git/refs/tags/v4.0.0`, "refused"),
  rest("DELETE", "/repos/Effect-TS/secret/git/refs/heads/main", "refused"),
  rest("POST", `${E}/releases`, "refused", { tag_name: "v4.0.0" }),
  rest("PATCH", `${E}/releases/1`, "refused", { draft: false }),
  rest("DELETE", `${E}/releases/1`, "refused"),
  rest("POST", `${E}/git/tags`, "refused", { tag: "v4.0.0", object: NEW, type: "commit" }),
  {
    name: "release asset upload",
    method: "POST",
    url: `https://uploads.github.com${E}/releases/1/assets?name=effect.tgz`,
    body: encoder.encode("asset"),
    expected: "refused",
  },

  // GraphQL queries: the read token of the org they name
  graphql(
    "query",
    {
      query: `{ repository(owner: "Effect-TS", name: "effect") { pullRequests(first: 1) { nodes { number } } } }`,
    },
    "read:Effect-TS",
  ),
  graphql(
    "query, owner in variables",
    {
      query: `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }`,
      variables: { owner: "Effectful-Tech", name: "clanka" },
    },
    "read:Effectful-Tech",
  ),
  graphql(
    "query, another org",
    { query: `{ repository(owner: "someone", name: "else") { id } }` },
    "anonymous",
  ),

  // GraphQL mutations the policy allows: the write token of the org the node is in
  graphql(
    "mergePullRequest",
    {
      query: `mutation { mergePullRequest(input: { pullRequestId: "PR_effect" }) { clientMutationId } }`,
    },
    "write:Effect-TS",
  ),
  graphql(
    "mergePullRequest, Effectful-Tech",
    {
      query: `mutation { mergePullRequest(input: { pullRequestId: "PR_clanka" }) { clientMutationId } }`,
    },
    "write:Effectful-Tech",
  ),
  graphql(
    "enablePullRequestAutoMerge",
    {
      query: `mutation { enablePullRequestAutoMerge(input: { pullRequestId: "PR_effect" }) { clientMutationId } }`,
    },
    "write:Effect-TS",
  ),
  graphql(
    "enqueuePullRequest",
    {
      query: `mutation { enqueuePullRequest(input: { pullRequestId: "PR_effect" }) { clientMutationId } }`,
    },
    "write:Effect-TS",
  ),
  graphql(
    "addPullRequestReview APPROVE",
    {
      query: `mutation { addPullRequestReview(input: { pullRequestId: "PR_effect", event: APPROVE }) { clientMutationId } }`,
    },
    "write:Effect-TS",
  ),
  graphql(
    "addComment",
    {
      query: `mutation { addComment(input: { subjectId: "I_effect", body: "hi" }) { clientMutationId } }`,
    },
    "write:Effect-TS",
  ),
  graphql(
    "createPullRequest",
    {
      query: `mutation { createPullRequest(input: { repositoryId: "R_effect", baseRefName: "main", headRefName: "feature", title: "t" }) { clientMutationId } }`,
    },
    "write:Effect-TS",
  ),
  graphql(
    "addLabelsToLabelable",
    {
      query: `mutation { addLabelsToLabelable(input: { labelableId: "I_effect", labelIds: ["L_bug"] }) { clientMutationId } }`,
    },
    "write:Effect-TS",
  ),
  graphql(
    "deleteRef on a branch",
    { query: `mutation { deleteRef(input: { refId: "REF_feature" }) { clientMutationId } }` },
    "write:Effect-TS",
  ),

  // GraphQL mutations the policy refuses
  graphql(
    "createCommitOnBranch",
    {
      query: `mutation { createCommitOnBranch(input: { branch: { repositoryNameWithOwner: "Effect-TS/effect", branchName: "feature" }, expectedHeadOid: "${OLD}", message: { headline: "m" } }) { clientMutationId } }`,
    },
    "refused",
  ),
  graphql(
    "createRef",
    {
      query: `mutation { createRef(input: { repositoryId: "R_effect", name: "refs/heads/x", oid: "${NEW}" }) { clientMutationId } }`,
    },
    "refused",
  ),
  graphql(
    "updateRef",
    {
      query: `mutation { updateRef(input: { refId: "REF_feature", oid: "${NEW}" }) { clientMutationId } }`,
    },
    "refused",
  ),
  graphql(
    "updateRefs",
    {
      query: `mutation { updateRefs(input: { repositoryId: "R_effect", refUpdates: [{ name: "refs/heads/feature", afterOid: "${NEW}" }] }) { clientMutationId } }`,
    },
    "refused",
  ),
  graphql(
    "deleteRef on the default branch",
    { query: `mutation { deleteRef(input: { refId: "REF_main" }) { clientMutationId } }` },
    "refused",
  ),
  graphql(
    "deleteRef on a protected branch",
    { query: `mutation { deleteRef(input: { refId: "REF_next" }) { clientMutationId } }` },
    "refused",
  ),
  graphql(
    "deleteRef on a tag",
    { query: `mutation { deleteRef(input: { refId: "REF_tag" }) { clientMutationId } }` },
    "refused",
  ),

  // Mutations are matched by field name, wherever they hide
  graphql(
    "aliased createRef",
    {
      query: `mutation { harmless: createRef(input: { repositoryId: "R_effect", name: "refs/heads/x", oid: "${NEW}" }) { clientMutationId } }`,
    },
    "refused",
  ),
  graphql(
    "addComment aliased as createRef",
    {
      query: `mutation { createRef: addComment(input: { subjectId: "I_effect", body: "hi" }) { clientMutationId } }`,
    },
    "write:Effect-TS",
  ),
  graphql(
    "batched addComment and updateRef",
    {
      query: `mutation { addComment(input: { subjectId: "I_effect", body: "hi" }) { clientMutationId } updateRef(input: { refId: "REF_feature", oid: "${NEW}" }) { clientMutationId } }`,
    },
    "refused",
  ),
  graphql(
    "batched deleteRefs on a branch and the default branch",
    {
      query: `mutation { a: deleteRef(input: { refId: "REF_feature" }) { clientMutationId } b: deleteRef(input: { refId: "REF_main" }) { clientMutationId } }`,
    },
    "refused",
  ),
  graphql(
    "createRef in a fragment",
    {
      query: `mutation { ...M } fragment M on Mutation { createRef(input: { repositoryId: "R_effect", name: "refs/heads/x", oid: "${NEW}" }) { clientMutationId } }`,
    },
    "refused",
  ),
  graphql(
    "createRef in an operation not selected",
    {
      query: `query Safe { viewer { login } } mutation Bad { createRef(input: { repositoryId: "R_effect", name: "refs/heads/x", oid: "${NEW}" }) { clientMutationId } }`,
      operationName: "Safe",
    },
    "refused",
  ),
  graphql(
    "deleteRef on the default branch through variables",
    {
      query: `mutation($input: DeleteRefInput!) { deleteRef(input: $input) { clientMutationId } }`,
      variables: { input: { refId: "REF_main" } },
    },
    "refused",
  ),
  graphql(
    "deleteRef on a branch through variables",
    {
      query: `mutation($ref: ID!) { deleteRef(input: { refId: $ref }) { clientMutationId } }`,
      variables: { ref: "REF_feature" },
    },
    "write:Effect-TS",
  ),
  graphql("a body that doesn't parse", { query: "mutation {" }, "refused"),
  {
    name: "graphql a body that isn't JSON",
    method: "POST",
    url: "https://api.github.com/graphql",
    body: encoder.encode("mutation { createRef }"),
    expected: "refused",
  },

  // Multica: the Janitor PAT on every path
  { name: "multica", method: "GET", url: "https://api.multica.ai/api/issues", expected: "multica" },
  {
    name: "multica",
    method: "POST",
    url: "https://api.multica.ai/api/issues/1/comments",
    body: encoder.encode(JSON.stringify({ content: "hi" })),
    expected: "multica",
  },
  {
    name: "multica",
    method: "DELETE",
    url: "https://api.multica.ai/api/issues/1",
    expected: "multica",
  },

  // Everything else: no credential
  { name: "npm", method: "GET", url: "https://registry.npmjs.org/effect", expected: "anonymous" },
  { name: "web", method: "GET", url: "https://example.com/", expected: "anonymous" },
  { name: "multica web", method: "GET", url: "https://multica.ai/", expected: "anonymous" },
  {
    name: "lookalike host",
    method: "GET",
    url: `https://api.github.com.evil.example${E}/pulls`,
    expected: "anonymous",
  },
  {
    name: "lookalike host",
    method: "GET",
    url: "https://api.multica.ai.evil.example/api/issues",
    expected: "anonymous",
  },
  {
    name: "plain http",
    method: "GET",
    url: `http://api.github.com${E}/pulls`,
    expected: "anonymous",
  },
]

const LABELS: ReadonlyArray<readonly [label: string, token: string]> = [
  ["read:Effect-TS", TOKENS["effect-ts"]!.read],
  ["write:Effect-TS", TOKENS["effect-ts"]!.write],
  ["read:Effectful-Tech", TOKENS["effectful-tech"]!.read],
  ["write:Effectful-Tech", TOKENS["effectful-tech"]!.write],
  ["multica", MULTICA_TOKEN],
]

/** Names the credential on a forwarded request: Basic for git on `github.com`, Bearer elsewhere. */
const credential = (request: Request) => {
  const authorization = request.headers.get("authorization")
  if (authorization === null) return "anonymous"
  const git = new URL(request.url).hostname === "github.com"
  for (const [label, token] of LABELS) {
    const expected = git ? `Basic ${btoa(`x-access-token:${token}`)}` : `Bearer ${token}`
    if (authorization === expected) return label
  }
  return `authorization: ${authorization}`
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, index) => byte === b[index])

/**
 * Sends one container request through the proxy and classifies the outcome:
 * `refused` (a 403 with a reason, nothing forwarded), or the credential on
 * the one forwarded request, which must keep its body intact and not follow
 * redirects.
 */
const send = (row: Row, headers: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const forwarded: Array<Request> = []
    const response = yield* handleChatEgress(
      new Request(row.url, {
        method: row.method,
        headers,
        ...(row.body === undefined ? {} : { body: row.body }),
      }),
      makeEgress(forwarded),
    )
    if (forwarded.length === 0) {
      const reason = yield* Effect.promise(() => response.text())
      return response.status === 403 && reason.length > 0 ? "refused" : `status ${response.status}`
    }
    if (forwarded.length > 1) return `forwarded ${forwarded.length} times`
    const request = forwarded[0]!
    if (request.redirect !== "manual") return `redirect: ${request.redirect}`
    if (row.body !== undefined) {
      const body = new Uint8Array(yield* Effect.promise(() => request.arrayBuffer()))
      if (!sameBytes(body, row.body)) return "body changed"
    }
    return { request, outcome: credential(request) }
  })

const describeRow = (row: Row) => `${row.name}: ${row.method} ${row.url}`

describe("chat egress proxy", () => {
  it.effect("applies the GitHub policy and injects the right credential", () =>
    Effect.gen(function* () {
      const outcomes = yield* Effect.forEach(table, (row) =>
        send(row).pipe(Effect.map((sent) => (typeof sent === "string" ? sent : sent.outcome))),
      )
      assert.deepStrictEqual(
        table.map((row, index) => `${describeRow(row)} -> ${outcomes[index]}`),
        table.map((row) => `${describeRow(row)} -> ${row.expected}`),
      )
    }),
  )

  it.effect("never forwards a container-supplied Authorization to GitHub or Multica", () =>
    Effect.gen(function* () {
      const secret = "ghp_from_the_container"
      const sent: ReadonlyArray<readonly [Row, string]> = [
        ...fetchRows("Effect-TS/effect", "").map(
          (row) => [row, `Basic ${btoa(`x-access-token:${secret}`)}`] as const,
        ),
        ...fetchRows("someone/else", "").map(
          (row) => [row, `Basic ${btoa(`x-access-token:${secret}`)}`] as const,
        ),
        [
          push("a branch", "Effect-TS/effect.git", [update("refs/heads/feature")], ""),
          `Basic ${btoa(`x-access-token:${secret}`)}`,
        ],
        [rest("GET", `${E}/pulls`, ""), `Bearer ${secret}`],
        [rest("POST", `${E}/issues`, "", { title: "t" }), `token ${secret}`],
        [rest("GET", "/repos/someone/else/pulls", ""), `Bearer ${secret}`],
        [rest("GET", "/user", ""), `Bearer ${secret}`],
        [
          graphql(
            "query, another org",
            { query: `{ repository(owner: "someone", name: "else") { id } }` },
            "",
          ),
          `Bearer ${secret}`,
        ],
        [
          {
            name: "multica",
            method: "GET",
            url: "https://api.multica.ai/api/issues",
            expected: "",
          },
          `Bearer ${secret}`,
        ],
      ]
      const leaks = yield* Effect.forEach(sent, ([row, authorization]) =>
        send(row, { authorization }).pipe(
          Effect.map((result) => {
            if (typeof result === "string") return `${describeRow(row)} -> ${result}`
            const leaked = [...result.request.headers].some(
              ([, value]) => value.includes(secret) || value.includes(authorization),
            )
            return `${describeRow(row)} -> ${leaked ? "leaked" : "clean"}`
          }),
        ),
      )
      assert.deepStrictEqual(
        leaks,
        sent.map(([row]) => `${describeRow(row)} -> clean`),
      )
    }),
  )

  /** Runs rows through the proxy and compares each outcome with its expectation, as the table does. */
  const expectOutcomes = (rows: ReadonlyArray<Row>) =>
    Effect.gen(function* () {
      const outcomes = yield* Effect.forEach(rows, (row) =>
        send(row).pipe(Effect.map((sent) => (typeof sent === "string" ? sent : sent.outcome))),
      )
      assert.deepStrictEqual(
        rows.map((row, index) => `${describeRow(row)} -> ${outcomes[index]}`),
        rows.map((row) => `${describeRow(row)} -> ${row.expected}`),
      )
    })

  it.effect("a mutation that names its target by plain id gets that org's write token", () =>
    expectOutcomes([
      graphql(
        "updateIssue",
        {
          query: `mutation { updateIssue(input: { id: "I_effect", title: "t" }) { clientMutationId } }`,
        },
        "write:Effect-TS",
      ),
    ]),
  )

  it.effect("org-scoped reads use that org's read token, and other orgs get none", () =>
    expectOutcomes([
      rest("GET", "/orgs/Effectful-Tech/repos", "read:Effectful-Tech"),
      rest("GET", "/orgs/someone/repos", "anonymous"),
      rest("GET", "/users/someone/repos", "anonymous"),
      rest("GET", "/search/issues?q=repo:Effect-TS/effect", "read:Effect-TS"),
    ]),
  )
})
