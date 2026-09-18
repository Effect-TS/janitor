import { GitHubInstallationId } from "@janitor/domain/GitHub/Id"
import type { DraftPublication } from "@janitor/domain/Review/Draft"
import type { ValidatedPatch } from "@janitor/domain/Review/Reproduction"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { GitHubTransport, type GitHubResponse } from "../GitHub/Transport.ts"
import { repositoryTarget } from "../Labeling/GitHubIssue.ts"
import type { Eligibility } from "../RepositoryEligibility.ts"
import { fetchBlob, fetchTree } from "./Evidence.ts"
import { validatePatch } from "./Patch.ts"

export interface ReproductionPullRequest {
  readonly number: number
  readonly title: string
  readonly body: string
  readonly head: string
  readonly headSha: string
  readonly base: string
  readonly repositoryId: string
  readonly open: boolean
  readonly draft: boolean
  readonly owned: boolean
}

/** Only immutable Git objects, new owned refs and new draft PRs can be written. */
export class ReviewPullRequests extends Context.Service<
  ReviewPullRequests,
  {
    readonly validate: (
      repository: Eligibility,
      patch: ValidatedPatch,
    ) => Effect.Effect<string, unknown>
    readonly tree: (
      repository: Eligibility,
      baseTree: string,
      patch: ValidatedPatch,
    ) => Effect.Effect<string, unknown>
    readonly commit: (
      repository: Eligibility,
      tree: string,
      base: string,
      message: string,
    ) => Effect.Effect<string, unknown>
    readonly branch: (
      repository: Eligibility,
      branch: string,
    ) => Effect.Effect<string | null, unknown>
    readonly createBranch: (
      repository: Eligibility,
      branch: string,
      commit: string,
    ) => Effect.Effect<void, unknown>
    readonly list: (
      repository: Eligibility,
      branch: string,
    ) => Effect.Effect<ReadonlyArray<ReproductionPullRequest>, unknown>
    readonly create: (
      repository: Eligibility,
      intent: DraftPublication,
      body: string,
    ) => Effect.Effect<ReproductionPullRequest, unknown>
  }
>()("Review/PullRequests") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const transport = yield* GitHubTransport
      const request = (
        repository: Eligibility,
        method: "GET" | "POST",
        path: string,
        body?: unknown,
      ) =>
        transport.request({
          scope: {
            _tag: "Installation",
            installationId: GitHubInstallationId.make(repository.installationId),
          },
          priority: "foreground",
          method,
          url: `/repos/${repository.name}/${path}`,
          repositoryPermission: {
            repositoryId: repository.repositoryId,
            issues: "read",
            ...(path.startsWith("pulls")
              ? { pullRequests: method === "GET" ? ("read" as const) : ("write" as const) }
              : { contents: method === "GET" ? ("read" as const) : ("write" as const) }),
          },
          ...(body === undefined ? {} : { body }),
        })
      const read =
        <A, I>(schema: Schema.Codec<A, I>) =>
        (response: GitHubResponse): Effect.Effect<A, string | Schema.SchemaError> =>
          response._tag === "Ok"
            ? Schema.decodeUnknownEffect(schema)(response.body)
            : Effect.fail("GitHub did not confirm the operation.")
      const Sha = Schema.Struct({ sha: Schema.String })
      const Pull = Schema.Struct({
        number: Schema.Int,
        title: Schema.String,
        body: Schema.NullOr(Schema.String),
        state: Schema.String,
        draft: Schema.Boolean,
        user: Schema.Struct({ id: Schema.Int }),
        head: Schema.Struct({
          ref: Schema.String,
          sha: Schema.String,
          repo: Schema.NullOr(Schema.Struct({ id: Schema.Int })),
        }),
        base: Schema.Struct({ ref: Schema.String, repo: Schema.Struct({ id: Schema.Int }) }),
      })
      const owner = (repository: Eligibility) =>
        Effect.gen(function* () {
          const app = yield* transport
            .request({ scope: { _tag: "App" }, priority: "foreground", method: "GET", url: "/app" })
            .pipe(Effect.flatMap(read(Schema.Struct({ slug: Schema.String }))))
          const bot = yield* transport
            .request({
              scope: {
                _tag: "Installation",
                installationId: GitHubInstallationId.make(repository.installationId),
              },
              repositoryPermission: { repositoryId: repository.repositoryId, issues: "read" },
              priority: "foreground",
              method: "GET",
              url: `/users/${encodeURIComponent(app.slug + "[bot]")}`,
            })
            .pipe(Effect.flatMap(read(Schema.Struct({ id: Schema.Int }))))
          return bot.id
        })
      const pull = (value: typeof Pull.Type, bot: number): ReproductionPullRequest => ({
        number: value.number,
        title: value.title,
        body: value.body ?? "",
        head: value.head.ref,
        headSha: value.head.sha,
        base: value.base.ref,
        repositoryId: String(value.base.repo.id),
        open: value.state === "open",
        draft: value.draft,
        owned: value.user.id === bot && value.head.repo?.id === value.base.repo.id,
      })
      return {
        validate: (repository, patch) =>
          Effect.gen(function* () {
            const target = repositoryTarget(repository)
            const tree = yield* fetchTree(target, patch.baseCommit).pipe(
              Effect.provideService(GitHubTransport, {
                request: (r) =>
                  transport.request({
                    ...r,
                    repositoryPermission: {
                      repositoryId: repository.repositoryId,
                      issues: "read",
                      contents: "read",
                    },
                  }),
              }),
            )
            const originals: Record<string, string> = {}
            for (const file of patch.files) {
              const entry = tree.find((e) => e.path === file.path)
              if (entry?.type === "blob" && entry.mode === "100644")
                originals[file.path] = yield* fetchBlob(target, entry.sha).pipe(
                  Effect.provideService(GitHubTransport, {
                    request: (r) =>
                      transport.request({
                        ...r,
                        repositoryPermission: {
                          repositoryId: repository.repositoryId,
                          issues: "read",
                          contents: "read",
                        },
                      }),
                  }),
                )
            }
            const validated = yield* validatePatch({
              baseCommit: patch.baseCommit,
              tree,
              files: patch.files,
              originals,
            })
            if (validated.diff !== patch.diff)
              return yield* Effect.fail("Saved patch no longer matches trusted validation.")
            const commit = yield* request(
              repository,
              "GET",
              `git/commits/${patch.baseCommit}`,
            ).pipe(Effect.flatMap(read(Schema.Struct({ tree: Sha }))))
            return commit.tree.sha
          }),
        tree: (repository, baseTree, patch) =>
          request(repository, "POST", "git/trees", {
            base_tree: baseTree,
            tree: patch.files.map((f) => ({
              path: f.path,
              mode: "100644",
              type: "blob",
              content: f.content,
            })),
          }).pipe(
            Effect.flatMap(read(Sha)),
            Effect.map((v) => v.sha),
          ),
        commit: (repository, tree, base, message) =>
          request(repository, "POST", "git/commits", { tree, parents: [base], message }).pipe(
            Effect.flatMap(read(Sha)),
            Effect.map((v) => v.sha),
          ),
        branch: (repository, branch) =>
          request(repository, "GET", `git/ref/heads/${encodeURIComponent(branch)}`).pipe(
            Effect.flatMap((r) =>
              r._tag === "Failed" && r.status === 404
                ? Effect.succeed(null)
                : read(Schema.Struct({ object: Sha }))(r).pipe(Effect.map((v) => v.object.sha)),
            ),
          ),
        createBranch: (repository, branch, commit) =>
          request(repository, "POST", "git/refs", {
            ref: `refs/heads/${branch}`,
            sha: commit,
          }).pipe(
            Effect.flatMap(read(Schema.Struct({ object: Sha }))),
            Effect.flatMap((v) =>
              v.object.sha === commit ? Effect.void : Effect.fail("Unexpected branch head."),
            ),
          ),
        list: (repository, branch) =>
          Effect.gen(function* () {
            const bot = yield* owner(repository)
            const all: Array<ReproductionPullRequest> = []
            for (let page = 1; ; page++) {
              const rows = yield* request(
                repository,
                "GET",
                `pulls?state=all&head=${encodeURIComponent(repository.name.split("/")[0] + ":" + branch)}&per_page=100&page=${page}`,
              ).pipe(Effect.flatMap(read(Schema.Array(Pull))))
              all.push(...rows.map((v) => pull(v, bot)))
              if (rows.length < 100) return all
            }
          }),
        create: (repository, intent, body) =>
          Effect.gen(function* () {
            const bot = yield* owner(repository)
            const value = yield* request(repository, "POST", "pulls", {
              title: intent.text.title,
              body,
              head: intent.branch,
              base: intent.defaultBranch,
              draft: true,
              maintainer_can_modify: false,
            }).pipe(Effect.flatMap(read(Pull)))
            return pull(value, bot)
          }),
      }
    }),
  )
}
