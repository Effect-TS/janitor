// Git operations for publication, run inside the sandbox on the session's
// checkout. Repository credentials enter the container only as the environment
// of one authenticated Git command; the model's shell never sees them. Pushes
// are guarded by the remote head the plan recorded, so nothing is overwritten.
import { Context, Effect, Layer } from "effect"
import { ProtocolError } from "../Protocol.ts"
import type { RepositoryCredential } from "../Publication.ts"
import { KeyValue } from "./KeyValue.ts"
import {
  REPOSITORY_DIR,
  SandboxWorkspace,
  asWorkspaceUser,
  gitEnvironment,
  shellQuote,
  type ExecOutcome,
  type WorkspaceError,
} from "./SandboxWorkspace.ts"

const hash = /^[a-f0-9]{40}$/
const GIT_TIMEOUT_MS = 120_000
const PUBLICATION_KEY = "_janitor_publication"

export interface PrepareInput extends RepositoryCredential {
  readonly branch: string
  readonly base: string
  readonly prepareId?: string
  readonly title: string
  readonly existing?: boolean
}
export interface PrepareResult {
  readonly status: "prepared" | "conflict" | "blocked"
  readonly message?: string
  readonly commit: string
  readonly baseCommit: string
  readonly remoteHead: string | null
}
export interface PushInput extends RepositoryCredential {
  readonly branch: string
  readonly commit?: string
  readonly remoteHead?: string | null
}
export interface InspectInput extends RepositoryCredential {
  readonly branch: string
  readonly commit?: string
}

/** Enough of a publication plan to reconcile the checkout with its external effects. */
interface PlanSnapshot {
  readonly phase: string
  readonly branch: string
  readonly commit?: string
}

export class WorkspacePublication extends Context.Service<
  WorkspacePublication,
  {
    readonly execute: (action: string, input: unknown) => Effect.Effect<unknown, ProtocolError>
    /**
     * Brings a freshly prepared checkout in line with writes an interrupted
     * publication may already have made: a pushed commit the local branch lost
     * is adopted from the remote, and a prepared-but-lost commit sends the plan
     * back to preparation. Runs before any turn on a restored workspace.
     */
    readonly reconcile: Effect.Effect<void, WorkspaceError | ProtocolError>
  }
>()("janitor/runner/WorkspacePublication") {
  static make(
    workspace: SandboxWorkspace["Service"],
    kv: KeyValue["Service"],
    remote: (credential: RepositoryCredential) => string,
  ): WorkspacePublication["Service"] {
    const git = (
      command: string,
      credential: RepositoryCredential | undefined,
      options: { readonly timeoutMs?: number } = {},
    ) =>
      workspace.exec(asWorkspaceUser(`git ${command}`), {
        cwd: REPOSITORY_DIR,
        env: gitEnvironment(credential?.token),
        timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS,
        user: "root",
      })
    const ok = (outcome: ExecOutcome) => outcome.exitCode === 0 && !outcome.timedOut
    const out = (outcome: ExecOutcome) => outcome.stdout.trim()
    const transport = (message: string) => new ProtocolError("transport", message)
    const blocked = (message: string) => Effect.fail(new ProtocolError("blocked", message))
    const mapWorkspace = <A>(effect: Effect.Effect<A, WorkspaceError>) =>
      Effect.mapError(effect, (error) =>
        transport(`Sandbox Git operation failed: ${error.message}`),
      )

    const revParse = (ref: string) =>
      git(`rev-parse --verify --quiet ${shellQuote(ref)}`, undefined).pipe(
        mapWorkspace,
        Effect.map((outcome) => (ok(outcome) && hash.test(out(outcome)) ? out(outcome) : null)),
      )
    const fetchBranch = (credential: RepositoryCredential, branch: string) =>
      git(
        `fetch --no-tags origin ${shellQuote(`+refs/heads/${branch}:refs/remotes/origin/${branch}`)}`,
        credential,
      ).pipe(
        mapWorkspace,
        Effect.flatMap((outcome) => {
          if (ok(outcome)) return revParse(`refs/remotes/origin/${branch}`)
          if (
            /couldn't find remote ref|remote branch .* not found|fatal: couldn't find/i.test(
              outcome.stderr,
            )
          )
            return Effect.succeed(null)
          return Effect.fail(transport(`Could not fetch ${branch} from GitHub`))
        }),
      )
    const isAncestor = (ancestor: string, descendant: string) =>
      git(
        `merge-base --is-ancestor ${shellQuote(ancestor)} ${shellQuote(descendant)}`,
        undefined,
      ).pipe(mapWorkspace, Effect.map(ok))
    const ensureRemote = (credential: RepositoryCredential) =>
      git(`remote set-url origin ${shellQuote(remote(credential))}`, undefined).pipe(mapWorkspace)

    const prepare = Effect.fn("WorkspacePublication.prepare")(function* (input: PrepareInput) {
      yield* ensureRemote(input)
      const status = yield* git("status --porcelain", undefined).pipe(mapWorkspace)
      if (!ok(status)) return yield* blocked("The checkout is not a Git repository")
      if (out(status) !== "") {
        const committed = yield* git(
          `add -A && git -c user.name=Janitor -c user.email=janitor@users.noreply.github.com commit --quiet -m ${shellQuote(input.title)}`,
          undefined,
        ).pipe(mapWorkspace)
        if (!ok(committed))
          return yield* blocked(
            `Uncommitted changes could not be committed: ${committed.stderr.trim()}`,
          )
      }
      const current = yield* git("rev-parse --abbrev-ref HEAD", undefined).pipe(mapWorkspace)
      if (out(current) !== input.branch) {
        const switched = yield* git(`checkout -B ${shellQuote(input.branch)}`, undefined).pipe(
          mapWorkspace,
        )
        if (!ok(switched)) return yield* blocked(`Could not switch to ${input.branch}`)
      }
      const remoteHead = yield* fetchBranch(input, input.branch)
      const head = yield* revParse("HEAD")
      if (head === null) return yield* blocked("The checkout has no commits")
      if (remoteHead !== null && !(yield* isAncestor(remoteHead, head))) {
        // Human commits landed on the branch: merge them before publishing.
        const merged = yield* git(
          `-c user.name=Janitor -c user.email=janitor@users.noreply.github.com merge --no-edit ${shellQuote(`refs/remotes/origin/${input.branch}`)}`,
          undefined,
        ).pipe(mapWorkspace)
        if (!ok(merged)) {
          yield* git("merge --abort", undefined).pipe(Effect.ignore)
          return {
            status: "conflict",
            message:
              "The remote branch has changes that conflict with the local commits. Resolve them in the workspace and publish again.",
            commit: head,
            baseCommit: "",
            remoteHead,
          } satisfies PrepareResult
        }
      }
      const baseHead = yield* fetchBranch(input, input.base)
      if (baseHead === null) return yield* blocked(`The base branch ${input.base} does not exist`)
      const commit = yield* revParse("HEAD")
      if (commit === null) return yield* blocked("The checkout has no commits")
      if (commit === baseHead || (yield* isAncestor(commit, baseHead)))
        return {
          status: "blocked",
          message: "There are no new commits to publish.",
          commit,
          baseCommit: baseHead,
          remoteHead,
        } satisfies PrepareResult
      return {
        status: "prepared",
        commit,
        baseCommit: baseHead,
        remoteHead,
      } satisfies PrepareResult
    })

    const push = Effect.fn("WorkspacePublication.push")(function* (input: PushInput) {
      yield* ensureRemote(input)
      const commit = input.commit
      if (commit === undefined || !hash.test(commit))
        return yield* blocked("No prepared commit to push")
      const lease =
        input.remoteHead === null || input.remoteHead === undefined
          ? `--force-with-lease=refs/heads/${input.branch}:`
          : `--force-with-lease=refs/heads/${input.branch}:${input.remoteHead}`
      const pushed = yield* git(
        `push ${shellQuote(lease)} origin ${shellQuote(`${commit}:refs/heads/${input.branch}`)}`,
        input,
        { timeoutMs: 300_000 },
      ).pipe(mapWorkspace)
      if (ok(pushed)) return { status: "pushed" }
      if (/stale info|rejected|fetch first|non-fast-forward/i.test(pushed.stderr))
        return { status: "stale" }
      return { status: "unconfirmed" }
    })

    const inspect = Effect.fn("WorkspacePublication.inspect")(function* (input: InspectInput) {
      yield* ensureRemote(input)
      const remoteHead = yield* fetchBranch(input, input.branch)
      const contains =
        remoteHead !== null && input.commit !== undefined && hash.test(input.commit)
          ? remoteHead === input.commit || (yield* isAncestor(input.commit, remoteHead))
          : false
      return { contains, remoteHead }
    })

    const reconcile = Effect.gen(function* () {
      const plan = yield* Effect.promise(() =>
        kv.get<PlanSnapshot & Record<string, unknown>>(PUBLICATION_KEY),
      )
      if (plan === undefined || plan.commit === undefined || !hash.test(plan.commit)) return
      const present = yield* git(
        `cat-file -e ${shellQuote(`${plan.commit}^{commit}`)}`,
        undefined,
      ).pipe(Effect.map(ok))
      const head = yield* revParse("HEAD").pipe(Effect.orElseSucceed(() => null))
      const onBranch =
        present &&
        head !== null &&
        (yield* isAncestor(plan.commit, head).pipe(Effect.orElseSucceed(() => false)))
      if (onBranch) return
      if (["pushing", "pushed", "creating", "complete"].includes(plan.phase)) {
        // The commit may exist on GitHub: adopt it from there rather than recreating it.
        const fetched = yield* git(
          `fetch --no-tags origin ${shellQuote(`+refs/heads/${plan.branch}:refs/remotes/origin/${plan.branch}`)}`,
          undefined,
          { timeoutMs: GIT_TIMEOUT_MS },
        )
        const remoteHead = ok(fetched)
          ? yield* revParse(`refs/remotes/origin/${plan.branch}`).pipe(
              Effect.orElseSucceed(() => null),
            )
          : null
        const contains =
          remoteHead !== null &&
          (remoteHead === plan.commit ||
            (yield* isAncestor(plan.commit, remoteHead).pipe(Effect.orElseSucceed(() => false))))
        if (contains) {
          const adopted = yield* git(
            `checkout -B ${shellQuote(plan.branch)} ${shellQuote(`refs/remotes/origin/${plan.branch}`)}`,
            undefined,
          )
          if (!ok(adopted))
            return yield* blocked(
              "Could not adopt the published branch into the restored workspace",
            )
          return
        }
        if (plan.phase === "complete") return
      }
      // The commit never reached GitHub, or its outcome is unknown and it is not there: prepare again.
      yield* Effect.promise(() => kv.put(PUBLICATION_KEY, { ...plan, phase: "conflict" }))
      yield* Effect.promise(() => kv.sync())
    }).pipe(Effect.withSpan("WorkspacePublication.reconcile"))

    return {
      execute: (action, input) => {
        switch (action) {
          case "prepare":
            return prepare(input as PrepareInput)
          case "push":
            return push(input as PushInput)
          case "inspect":
            return inspect(input as InspectInput)
          default:
            return Effect.fail(new ProtocolError("invalid_request", `Unknown Git action ${action}`))
        }
      },
      reconcile,
    }
  }
  static layer(remote: (credential: RepositoryCredential) => string) {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const workspace = yield* SandboxWorkspace
        const kv = yield* KeyValue
        return WorkspacePublication.make(workspace, kv, remote)
      }),
    )
  }
}

export const githubRemote = (credential: RepositoryCredential) =>
  `https://github.com/${credential.owner}/${credential.repo}.git`
