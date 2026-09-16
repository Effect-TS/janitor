import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { describe, expect, it } from "vite-plus/test"
import type { Sandbox } from "../../src/AI/Sandbox.ts"
import { makeSandboxLocal } from "../../src/AI/SandboxLocal.ts"
import * as Workspace from "../../src/Workspace/Workspace.ts"

const withSandbox = <A, E>(
  use: (
    sandbox: Sandbox["Service"],
    fs: FileSystem.FileSystem,
    root: string,
    path: Path.Path,
  ) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const parent = yield* fs.makeTempDirectoryScoped()
        const root = path.join(parent, "workspace")
        const sandbox = yield* makeSandboxLocal.pipe(Effect.provide(Workspace.fixed(root)))
        // Building the runtime during planning must not create the workspace.
        expect(yield* fs.exists(root)).toBe(false)
        return yield* use(sandbox, fs, root, path)
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  )

describe("sandbox guest operations", () => {
  it("round-trips files and directories", () =>
    withSandbox((sandbox) =>
      Effect.gen(function* () {
        yield* sandbox.mkdir("src/nested")
        yield* sandbox.writeFile("src/message.txt", "first")
        yield* sandbox.writeFile("src/message.txt", "updated")
        expect(yield* sandbox.readFile("src/message.txt")).toBe("updated")
        expect(yield* sandbox.exists("src/message.txt")).toBe(true)
        expect(yield* sandbox.listFiles("src")).toEqual([
          { name: "message.txt", type: "file" },
          { name: "nested", type: "directory" },
        ])
        yield* sandbox.deleteFile("src/message.txt")
        expect(yield* sandbox.exists("src/message.txt")).toBe(false)
        yield* sandbox.writeFile("binary", "\0")
        expect(yield* sandbox.readFile("binary").pipe(Effect.flip)).toContain("binary")
      }),
    ))

  it("contains paths and symlinks for existing and new files", () =>
    withSandbox((sandbox, fs, root, path) =>
      Effect.gen(function* () {
        yield* sandbox.mkdir("src")
        const outside = path.join(path.dirname(root), "outside")
        yield* fs.makeDirectory(outside)
        yield* fs.writeFileString(path.join(outside, "secret"), "preserved")
        yield* fs.symlink(outside, path.join(root, "escape"))
        for (const target of ["../outside/secret", path.join(outside, "secret"), "escape/secret"]) {
          expect(yield* sandbox.readFile(target).pipe(Effect.flip)).toContain("[policy denial]")
        }
        expect(yield* sandbox.writeFile("escape/new/file", "bad").pipe(Effect.flip)).toContain(
          "[policy denial]",
        )
        expect(yield* fs.exists(path.join(outside, "new"))).toBe(false)
        expect(yield* fs.readFileString(path.join(outside, "secret"))).toBe("preserved")
      }),
    ))

  it("executes with quoted args, cwd, environment and retained output", () =>
    withSandbox((sandbox) =>
      Effect.gen(function* () {
        yield* sandbox.mkdir("nested")
        const quoted = yield* sandbox.exec("printf", ["%s", "a'b; $HOME"])
        expect(quoted.stdout).toBe("a'b; $HOME")
        const result = yield* sandbox.exec(
          'printf "%s" "$SANDBOX_TEST"; printf error >&2; exit 3',
          [],
          {
            cwd: "nested",
            env: { SANDBOX_TEST: "123456789" },
            maxRetainedBytes: 4,
          },
        )
        expect(result).toMatchObject({
          success: false,
          exitCode: 3,
          stdout: "6789",
          stderr: "rror",
          stdoutTruncated: true,
          stderrTruncated: true,
        })
        yield* sandbox.exec("printf ok > marker", [], { cwd: "nested" })
        expect(yield* sandbox.readFile("nested/marker")).toBe("ok")
      }),
    ))

  it("terminates commands after their timeout", () =>
    withSandbox((sandbox) =>
      Effect.gen(function* () {
        const failure = yield* sandbox.exec("sleep 30", [], { timeout: 30 }).pipe(Effect.flip)
        expect(failure).toContain("timed out after 30ms")
      }),
    ))
})
