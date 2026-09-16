import * as Dockerfile from "alchemy/Docker/Dockerfile"
import * as Effect from "effect/Effect"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { makeSandboxLocal } from "../../AI/SandboxLocal.ts"
import * as Workspace from "../../Workspace/Workspace.ts"
import { SandboxContainerImage } from "./SandboxContainer.ts"

/** Node.js plus the command-line tools used by sandbox operations. */
export const SANDBOX_DOCKERFILE = Dockerfile.inline`
  FROM node:24-bookworm-slim

  RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates curl git ripgrep openssh-client \
    && rm -rf /var/lib/apt/lists/*

  WORKDIR /workspace
`

/** Provide on the stack to build and deploy the /workspace sandbox guest. */
export const SandboxContainerRuntime = SandboxContainerImage.make(
  {
    main: import.meta.url,
    runtime: "node",
    dockerfile: SANDBOX_DOCKERFILE,
  },
  Effect.gen(function* () {
    const sandbox = yield* makeSandboxLocal
    return {
      exec: sandbox.exec,
      readFile: sandbox.readFile,
      writeFile: sandbox.writeFile,
      deleteFile: sandbox.deleteFile,
      mkdir: sandbox.mkdir,
      listFiles: sandbox.listFiles,
      exists: sandbox.exists,
      fetch: HttpServerResponse.json({ ok: true }),
    }
  }).pipe(Effect.provide(Workspace.fixed("/workspace"))),
)

export default SandboxContainerRuntime
