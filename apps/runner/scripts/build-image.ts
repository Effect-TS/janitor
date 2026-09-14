import { Effect, FileSystem } from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Docker, DockerLive } from "alchemy/Docker"
import { bridgeSourceHash } from "./bridge-source.mjs"

const image = "localhost/janitor-runner-sandbox:dev"
const build = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const docker = yield* Docker
  const sourceHash = bridgeSourceHash(new URL("../bridge/", import.meta.url))
  yield* fs.writeFileString("bridge/build.json", JSON.stringify({ sourceHash }, null, 2) + "\n")
  yield* docker.image.build({ tag: image, context: "bridge", platform: "linux/amd64" })
  if (!process.argv.includes("--record")) return
  const inspected = yield* docker.image.inspect(image)
  const digest =
    (inspected as typeof inspected & { Digest?: string }).Digest ??
    inspected.RepoDigests?.[0]?.split("@")[1]
  if (!digest)
    return yield* Effect.die(
      new Error("Image has no manifest digest; publish it before recording a release"),
    )
  const versions = yield* docker.run([
    "run",
    "--rm",
    "--network=none",
    "--entrypoint",
    "node",
    image,
    "--input-type=module",
    "-e",
    "import {execFileSync} from 'node:child_process'; console.log(JSON.stringify({node:process.version,packages:execFileSync('dpkg-query',['-W','coreutils','findutils','ripgrep','git','util-linux','ca-certificates'],{encoding:'utf8'})}))",
  ])
  const existing = JSON.parse(yield* fs.readFileString("bridge/release.json"))
  const engine = yield* docker.run(["version", "--format", "{{.Client.Version}}"])
  yield* fs.writeFileString(
    "bridge/release.json",
    JSON.stringify(
      {
        ...existing,
        sourceHash,
        imageDigest: digest,
        imageId: inspected.Id,
        buildEngine: engine.stdout.trim(),
        ...JSON.parse(versions.stdout),
      },
      null,
      2,
    ) + "\n",
  )
})
NodeRuntime.runMain(build.pipe(Effect.provide(DockerLive), Effect.provide(NodeServices.layer)))
