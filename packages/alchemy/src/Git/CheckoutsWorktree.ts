import { createHash } from "node:crypto"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { Checkout, CheckoutOptions, Checkouts, GitError, failure } from "./Checkouts.ts"
import { CheckoutRecord, CheckoutRecordJson } from "./CheckoutRecord.ts"
import { makeEnvironment } from "./Command.ts"
import { defaultBranch } from "./Remote.ts"

const digest = (value: string) =>
  Effect.sync(() => createHash("sha256").update(value).digest("hex"))

/** Shared bare repositories and independent worktrees, without touching the developer's checkout. */
export const makeCheckoutsWorktree = Effect.fnUntraced(function* (options: {
  readonly root: string
}) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* Effect.context<ChildProcessSpawner>()
  const environment = yield* makeEnvironment
  const root = path.resolve(options.root)
  const repositories = `${root}.repos`
  const records = `${root}.state`
  const lock = yield* Semaphore.make(1)
  const locked = Semaphore.withPermits(lock, 1)

  const git = Effect.fnUntraced(
    function* (args: ReadonlyArray<string>, env?: Record<string, string>) {
      const handle = yield* ChildProcess.make("git", args, {
        env: { GIT_TERMINAL_PROMPT: "0", ...env },
        extendEnv: true,
      })
      const [exitCode, stdout, stderr] = yield* Effect.all(
        [
          handle.exitCode,
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
        ],
        { concurrency: 3 },
      )
      if (exitCode !== 0) return yield* new GitError({ command: args.join(" "), exitCode, stderr })
      return stdout.trim()
    },
    Effect.scoped,
    Effect.provide(spawner),
    Effect.mapError(failure("worktree")),
    Effect.timeoutOrElse({
      duration: "2 minutes",
      orElse: () => Effect.fail(failure("worktree")("git operation timed out")),
    }),
  )

  const locations = Effect.fnUntraced(function* (key: string) {
    yield* Schema.decodeEffect(Schema.NonEmptyString)(key).pipe(
      Effect.mapError(failure("workspace key")),
    )
    const id = yield* digest(key)
    return { id, tree: path.join(root, id), marker: path.join(records, `${id}.json`) }
  })

  const read = Effect.fnUntraced(
    function* (key: string) {
      const location = yield* locations(key)
      if (!(yield* fs.exists(location.marker))) return Option.none<CheckoutRecord>()
      const record = yield* Schema.decodeEffect(CheckoutRecordJson)(
        yield* fs.readFileString(location.marker),
      )
      if (
        record.checkout.key !== key ||
        record.checkout.root !== location.tree ||
        record.checkout.path !== location.id
      ) {
        return yield* failure("checkout marker")("checkout identity does not match its directory")
      }
      return Option.some(record)
    },
    Effect.mapError(failure("checkout marker")),
  )

  const write = Effect.fnUntraced(
    function* (record: CheckoutRecord) {
      const location = yield* locations(record.checkout.key)
      yield* fs.makeDirectory(records, { recursive: true })
      const temp = yield* fs.makeTempDirectoryScoped({ directory: records })
      const file = path.join(temp, "record")
      yield* fs.writeFileString(file, yield* Schema.encodeEffect(CheckoutRecordJson)(record))
      yield* fs.rename(file, location.marker)
    },
    Effect.scoped,
    Effect.mapError(failure("checkout marker")),
  )

  const checkout = Effect.fnUntraced(
    function* (input: CheckoutOptions) {
      const request = yield* Schema.decodeEffect(CheckoutOptions, {
        onExcessProperty: "error",
      })(input).pipe(Effect.mapError(failure("checkout")))
      const location = yield* locations(request.key)
      const current = yield* read(request.key)
      const ref = request.ref ?? defaultBranch(request.remote)
      if (Option.isSome(current)) {
        if (current.value.checkout.remote.url !== request.remote.url)
          return yield* failure("checkout")(
            "key already belongs to another repository; release it first",
          )
        if (current.value.state === "Ready" && !request.fresh) {
          if (current.value.checkout.ref !== ref)
            return yield* failure("checkout")(
              "checkout ref changed; request fresh to discard local changes",
            )
          if (yield* fs.exists(location.tree)) return current.value.checkout
        }
      } else if (yield* fs.exists(location.tree)) {
        return yield* failure("checkout")(
          "unowned workspace directory exists; its files were preserved",
        )
      }

      const repo = path.join(repositories, yield* digest(request.remote.url))
      const branch = `janitor/${location.id}`
      const value: Checkout = {
        key: request.key,
        remote: request.remote,
        ref,
        root: location.tree,
        path: location.id,
        branch,
      }
      yield* write({ state: "Pending", checkout: value })
      yield* fs.makeDirectory(root, { recursive: true })
      yield* fs.makeDirectory(repo, { recursive: true })
      yield* git(["init", "--bare", repo])
      yield* git(["--git-dir", repo, "config", "remote.origin.url", request.remote.url])
      yield* git(["--git-dir", repo, "fetch", "origin", ref], yield* environment(request.remote))
      // FETCH_HEAD is per worktree; resolve it in the bare repository that fetched.
      const commit = yield* git(["--git-dir", repo, "rev-parse", "FETCH_HEAD"])
      if (!(yield* fs.exists(location.tree))) {
        yield* git(["--git-dir", repo, "worktree", "prune"])
        yield* git([
          "--git-dir",
          repo,
          "worktree",
          "add",
          "--force",
          "-B",
          branch,
          location.tree,
          commit,
        ])
      } else {
        yield* git(["-C", location.tree, "checkout", "--force", "-B", branch, commit])
        yield* git(["-C", location.tree, "reset", "--hard", commit])
        yield* git(["-C", location.tree, "clean", "-fd"])
      }
      yield* write({ state: "Ready", checkout: value })
      return value
    },
    locked,
    Effect.mapError(failure("checkout")),
  )

  const get = Effect.fnUntraced(
    function* (key: string) {
      const record = yield* read(key)
      if (Option.isNone(record) || record.value.state !== "Ready") return Option.none<Checkout>()
      if (!(yield* fs.exists(record.value.checkout.root))) return Option.none<Checkout>()
      return Option.some(record.value.checkout)
    },
    locked,
    Effect.mapError(failure("get checkout")),
  )

  const release = Effect.fnUntraced(
    function* (key: string) {
      const record = yield* read(key)
      if (Option.isNone(record)) return
      const location = yield* locations(key)
      const repo = path.join(repositories, yield* digest(record.value.checkout.remote.url))
      if (yield* fs.exists(location.tree)) {
        yield* git(["--git-dir", repo, "worktree", "remove", "--force", location.tree])
      }
      if (yield* fs.exists(repo)) {
        yield* git(["--git-dir", repo, "worktree", "prune"])
        yield* git([
          "--git-dir",
          repo,
          "update-ref",
          "-d",
          `refs/heads/${record.value.checkout.branch}`,
        ])
      }
      yield* fs.remove(location.marker, { force: true })
    },
    locked,
    Effect.mapError(failure("release")),
  )

  return Checkouts.of({ checkout, get, release })
})

export const layerWorktree = (options: { readonly root: string }) =>
  Layer.effect(Checkouts, makeCheckoutsWorktree(options))
