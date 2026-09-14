import { Config, Effect, FileSystem, Schema } from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const Image = Schema.Struct({
  imageRef: Schema.String,
  imageId: Schema.String,
  sourceHash: Schema.String,
  tools: Schema.Struct({ node: Schema.String, packages: Schema.String }),
})

// Image publication is an Alchemy resource. This build only produces its matching Worker artifact.
const build = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner
  const image = yield* Config.String("JANITOR_RUNNER_IMAGE").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Image))),
  )
  if (!/@sha256:[a-f0-9]{64}$/.test(image.imageRef))
    return yield* Effect.die(new Error("Runner image must be an immutable registry reference"))
  const manifest = JSON.parse(yield* fs.readFileString("release-manifest.json"))
  if (manifest.bridge.sourceHash !== image.sourceHash)
    return yield* Effect.die(new Error("Runner and sandbox sources differ"))
  manifest.bridge.imageDigest = image.imageRef.split("@")[1]
  manifest.bridge.imageId = image.imageId
  manifest.bridge.tools = image.tools
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "janitor-release-" })
  const path = `${directory}/release-manifest.json`
  yield* fs.writeFileString(path, JSON.stringify(manifest, null, 2) + "\n")
  const code = yield* spawner.exitCode(
    ChildProcess.make(process.execPath, ["scripts/build.mjs"], {
      env: { ...process.env, JANITOR_DEPLOY_MANIFEST: path },
      stdout: "inherit",
      stderr: "inherit",
    }),
  )
  if (code !== 0)
    return yield* Effect.die(new Error(`Runner bundling failed with exit code ${code}`))
  yield* fs.copyFile(path, "dist/release-manifest.json")
  yield* fs.writeFileString("dist/image-provenance.json", JSON.stringify(image, null, 2) + "\n")
})

NodeRuntime.runMain(build.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
