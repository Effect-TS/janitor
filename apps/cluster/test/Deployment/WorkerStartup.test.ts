/* oxlint-disable effecttsgo/prefer-schema-over-json -- Generate quoted Cap'n Proto and JavaScript literals, not JSON payloads. */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, it } from "@effect/vitest"
import { provideFreshArtifactStore, scopedArtifacts } from "alchemy/Artifacts"
import { makeSourceContext, resolveSource } from "alchemy/Cloudflare/Workers"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { createRequire } from "node:module"

it.live(
  "loads the production worker bundle in workerd",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "janitor-worker-startup-" })
      // Match the pinned workerd version; production's September 5 date is newer.
      const compatibility = { date: "2026-09-01", flags: ["nodejs_compat"] }
      const props = { main: new URL("../../src/Worker.ts", import.meta.url).href }
      const source = yield* resolveSource(props)
      const { bundle } = yield* source.build(
        makeSourceContext({
          id: "ClusterWorker",
          fqn: "ClusterWorker",
          workerName: "startup-test",
          props,
          compatibility,
          stack: { name: "janitor", stage: "production" },
        }),
      )
      assert.isDefined(bundle)
      const modules = []
      for (const file of bundle!.files) {
        if (!file.path.endsWith(".js")) continue
        const name = path.basename(file.path)
        yield* fs.writeFile(
          path.join(directory, name),
          typeof file.content === "string" ? new TextEncoder().encode(file.content) : file.content,
        )
        modules.push(`(name = ${JSON.stringify(name)}, esModule = embed ${JSON.stringify(name)})`)
      }
      yield* fs.writeFileString(
        path.join(directory, "test.js"),
        `import Worker from ${JSON.stringify(`./${path.basename(bundle!.files[0].path)}`)};
export default { test() { if (typeof Worker !== "function") throw new Error("Missing worker entrypoint"); } };`,
      )
      modules.unshift('(name = "test.js", esModule = embed "test.js")')
      const config = path.join(directory, "config.capnp")
      yield* fs.writeFileString(
        config,
        `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (services = [(name = "startup", worker = (
  compatibilityDate = ${JSON.stringify(compatibility.date)},
  compatibilityFlags = ${JSON.stringify(compatibility.flags)},
  modules = [${modules.join(",")}]
))]);`,
      )
      // workerd test evaluates every static initializer before invoking test().
      // No production bindings, credentials, network requests, or containers are needed.
      const exitCode = yield* spawner
        .exitCode(
          ChildProcess.make(
            createRequire(import.meta.url).resolve("workerd/bin/workerd"),
            ["test", config],
            {
              stderr: "inherit",
            },
          ),
        )
        .pipe(Effect.timeout("15 seconds"))
      assert.equal(exitCode, 0)
    }).pipe(
      Effect.provide(scopedArtifacts("ClusterWorker")),
      provideFreshArtifactStore,
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  { timeout: 30_000 },
)
