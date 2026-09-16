import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { describe, expect, it } from "vite-plus/test"
import { Sandbox } from "../../src/AI/Sandbox.ts"
import { makeSandboxLocal } from "../../src/AI/SandboxLocal.ts"
import { makeCheckoutsSandbox } from "../../src/Git/CheckoutsSandbox.ts"
import { makeCheckoutsWorktree } from "../../src/Git/CheckoutsWorktree.ts"
import * as Workspace from "../../src/Workspace/Workspace.ts"

import { repositoryFixture } from "./RepositoryFixture.ts"

describe.each(["sandbox", "worktree"] as const)("%s checkouts", (backend) => {
  it(
    "acquires, preserves edits, resets refs and releases only its checkout",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { fs, path, parent, source, remote, first } = yield* repositoryFixture
          const root = path.join(parent, "workspaces")
          const raw = yield* makeSandboxLocal.pipe(Effect.provide(Workspace.fixed(root)))
          const make =
            backend === "sandbox"
              ? makeCheckoutsSandbox.pipe(Effect.provideService(Sandbox, raw))
              : makeCheckoutsWorktree({ root })
          const checkouts = yield* make
          const options = { key: "owner/repo#7", remote }
          expect(Option.isNone(yield* checkouts.get(options.key))).toBe(true)
          const acquired = yield* checkouts.checkout(options)
          expect(yield* fs.readFileString(path.join(acquired.root, "README.md"))).toBe("initial")
          yield* fs.writeFileString(path.join(acquired.root, "README.md"), "unpublished")
          yield* fs.writeFileString(path.join(acquired.root, "untracked"), "keep")
          // Rebuilding the service must preserve work and recover checkout identity from disk.
          const restarted = yield* make
          expect(yield* restarted.checkout(options)).toEqual(acquired)
          expect(yield* fs.readFileString(path.join(acquired.root, "README.md"))).toBe(
            "unpublished",
          )
          const conflict = yield* restarted
            .checkout({ ...options, ref: "feature" })
            .pipe(Effect.flip)
          expect(conflict.stderr).toContain("fresh")
          yield* restarted.checkout({ ...options, ref: "refs/pull/7/head", fresh: true })
          expect(yield* fs.readFileString(path.join(acquired.root, "README.md"))).toBe("feature")
          expect(yield* fs.exists(path.join(acquired.root, "untracked"))).toBe(false)
          yield* restarted.checkout({ ...options, ref: first, fresh: true })
          expect(yield* fs.readFileString(path.join(acquired.root, "README.md"))).toBe("initial")
          if (backend === "worktree") {
            const other = yield* restarted.checkout({ ...options, key: "another", ref: "feature" })
            expect(other.root).not.toBe(acquired.root)
            yield* restarted.release(options.key)
            expect(yield* fs.readFileString(path.join(other.root, "README.md"))).toBe("feature")
            yield* restarted.release("another")
          } else {
            expect(
              (yield* restarted.checkout({ ...options, key: "another" }).pipe(Effect.flip)).stderr,
            ).toContain("another checkout")
          }
          yield* restarted.release(options.key)
          yield* restarted.release(options.key)
          expect(Option.isNone(yield* restarted.get(options.key))).toBe(true)
          expect(yield* fs.readFileString(path.join(source, "README.md"))).toBe("initial")
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      ),
    20_000,
  )

  it(
    "retries failed acquisition without treating partial state as ready",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { path, parent, remote } = yield* repositoryFixture
          const root = path.join(parent, "workspaces")
          const raw = yield* makeSandboxLocal.pipe(Effect.provide(Workspace.fixed(root)))
          const checkouts = yield* backend === "sandbox"
            ? makeCheckoutsSandbox.pipe(Effect.provideService(Sandbox, raw))
            : makeCheckoutsWorktree({ root })
          yield* checkouts.checkout({ key: "retry", remote, ref: "missing" }).pipe(Effect.flip)
          expect(Option.isNone(yield* checkouts.get("retry"))).toBe(true)
          const acquired = yield* checkouts.checkout({ key: "retry", remote })
          expect(acquired.ref).toBe("main")
          yield* checkouts.release("retry")
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      ),
    20_000,
  )
})
