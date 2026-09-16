import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { expect, it } from "vite-plus/test"
import { Sandbox } from "../../src/AI/Sandbox.ts"
import { layerDevSession } from "../../src/AI/SandboxSession.ts"
import { Checkouts } from "../../src/Git/Checkouts.ts"
import { layerWorkspace } from "../../src/Git/CheckoutsWorkspace.ts"
import { SessionWorkspace } from "../../src/Workspace/SessionWorkspace.ts"
import { serveWorkspace } from "../../src/Workspace/WorkspaceServe.ts"
import { repositoryFixture } from "../Git/RepositoryFixture.ts"

it(
  "routes lazy sessions over Node HTTP and propagates errors",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { path, parent, remote, fs, source } = yield* repositoryFixture
        const root = path.join(parent, "workspaces")
        const url = yield* serveWorkspace({ root })
        const checkouts = yield* Checkouts.pipe(Effect.provide(layerWorkspace(url)))
        expect(Option.isNone(yield* checkouts.get("first"))).toBe(true)
        yield* Effect.gen(function* () {
          const sandbox = yield* Sandbox
          const workspace = yield* SessionWorkspace
          expect(yield* fs.exists(root)).toBe(false)
          expect(yield* sandbox.readFile("README.md")).toBe("initial")
          yield* sandbox.mkdir("nested")
          yield* sandbox.writeFile("nested/file", "first session")
          expect(yield* sandbox.exists("nested/file")).toBe(true)
          expect(yield* sandbox.listFiles("nested")).toEqual([{ name: "file", type: "file" }])
          const result = yield* sandbox.exec("cat", ["file"], { cwd: "nested" })
          expect(result.stdout).toBe("first session")
          expect(yield* sandbox.readFile("../outside").pipe(Effect.flip)).toContain("path escapes")
          yield* sandbox.deleteFile("nested/file")
          expect(yield* sandbox.exists("nested/file")).toBe(false)
          yield* Effect.gen(function* () {
            const other = yield* Sandbox
            expect(yield* other.exists("nested")).toBe(false)
            yield* other.writeFile("README.md", "second session")
          }).pipe(Effect.provide(layerDevSession({ key: "second", remote, url })))
          expect(yield* sandbox.readFile("README.md")).toBe("initial")
          yield* workspace.release
          expect(Option.isNone(yield* checkouts.get("first"))).toBe(true)
        }).pipe(Effect.provide(layerDevSession({ key: "first", remote, url })))
        const conflict = yield* checkouts
          .checkout({ key: "second", remote, ref: "feature" })
          .pipe(Effect.flip)
        expect(conflict.stderr).toContain("fresh")
        expect(yield* fs.readFileString(path.join(source, "README.md"))).toBe("initial")
        const client = yield* HttpClient.HttpClient
        const malformed = yield* client.execute(
          HttpClientRequest.post(`${url}/__rpc__/workspaceEnsure`).pipe(
            HttpClientRequest.bodyJsonUnsafe([{ key: "invalid" }]),
          ),
        )
        expect(yield* malformed.json).toMatchObject({ _tag: "~alchemy/rpc/error" })
        const browser = yield* client.execute(
          HttpClientRequest.post(`${url}/__rpc__/workspaceDrop`).pipe(
            HttpClientRequest.bodyJsonUnsafe(["second"]),
            HttpClientRequest.setHeader("origin", "https://example.test"),
          ),
        )
        expect(browser.status).toBe(403)
        yield* checkouts.release("second")
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
      ),
    ),
  30_000,
)
