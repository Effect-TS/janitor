import { runnerWorkerName } from "@janitor/cluster/Agent/RunnerBinding"
import { RunnerImage } from "../deployment/RunnerImage.ts"
import { hashDirectory } from "alchemy/Command/Memo"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Command from "alchemy/Command"
import * as Effect from "effect/Effect"
import * as Config from "effect/Config"
import * as FileSystem from "effect/FileSystem"
import * as Output from "alchemy/Output"
import { retain } from "alchemy/RemovalPolicy"
import ClusterWorker from "@janitor/cluster/Worker"
import { deployment, requiredSecret, agentRunnerConnection } from "@janitor/cluster/Deployment"

// No new resource scope: existing Alchemy addresses and namespace identities stay stable.
export const AgentRunner = Effect.gen(function* () {
  const target = yield* deployment
  const cluster = yield* ClusterWorker
  const local = target.stage === "local"
  const connection = yield* agentRunnerConnection
  const liveModel =
    local && (yield* Config.Boolean("JANITOR_LOCAL_LIVE_MODEL").pipe(Config.withDefault(false)))
  const fs = yield* FileSystem.FileSystem
  const modelConfigurations =
    local && !liveModel
      ? JSON.stringify({
          default: "local",
          records: [
            {
              id: "local",
              provider: "local",
              apiModelId: "local",
              route: "openai-chat",
              endpoint: "https://local.invalid/v1/",
              secretBinding: "LOCAL_MODEL_TOKEN",
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 100000, output: 4000 },
            },
          ],
        })
      : yield* Config.String("JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS").pipe(
          Config.withDefault(
            yield* fs
              .readFileString("apps/runner/model-configurations/openrouter-llama-3.1-8b.json")
              .pipe(Effect.orDie),
          ),
        )
  const manifest = JSON.parse(
    yield* fs.readFileString("apps/runner/release-manifest.json").pipe(Effect.orDie),
  ) as {
    bridge: { sourceHash: string }
  }
  const image = local
    ? undefined
    : yield* RunnerImage("AgentSandboxImage", {
        context: "apps/runner/bridge",
        sourceHash: manifest.bridge.sourceHash,
        contentHash: yield* hashDirectory({
          cwd: "apps/runner/bridge",
          memo: { include: ["Dockerfile", "*.mjs", "build.json"] },
        }).pipe(Effect.orDie),
        accountId: yield* Config.String("CLOUDFLARE_ACCOUNT_ID"),
      }).pipe(retain())
  const build = yield* Command.Build("AgentRunnerBuild", {
    cwd: "apps/runner",
    command: local ? "vp run --no-cache build:dev" : "vp run --no-cache build:deploy",
    outdir: local ? "dist-dev" : "dist",
    env:
      image === undefined
        ? {}
        : {
            JANITOR_RUNNER_IMAGE: Output.all(
              image.imageRef,
              image.imageId,
              image.sourceHash,
              image.tools,
            ).pipe(
              Output.map(([imageRef, imageId, sourceHash, tools]) =>
                JSON.stringify({ imageRef, imageId, sourceHash, tools }),
              ),
            ),
          },
    memo: {
      include: [
        "src/**",
        "scripts/**",
        "package.json",
        "../../pnpm-lock.yaml",
        "../../pnpm-workspace.yaml",
        "../../patches/**",
        "release-manifest.json",
        "bridge/**",
        "dev/**",
      ],
    },
    timeout: "15 minutes",
  })
  const checkpoints = yield* Cloudflare.R2.Bucket("AgentWorkspaceCheckpoints", {
    name: local ? "janitor-workspace-checkpoints-local" : "janitor-workspace-checkpoints",
  }).pipe(retain())
  return yield* Cloudflare.Worker("AgentRunner", {
    name: runnerWorkerName,
    main: Output.interpolate`${build.outdir}/worker.mjs`,
    bundle: false,
    ...(local ? { dev: { port: 8790, strictPort: true } } : { domain: `runner.${target.domain}` }),
    workersDev: false,
    compatibility: { date: local ? "2026-07-04" : "2026-09-05", flags: ["nodejs_compat"] },
    observability: { enabled: true },
    env: {
      SESSIONS: Cloudflare.DurableObject("AgentSessions", { className: "SessionRunner" }),
      SANDBOXES: Cloudflare.Container("AgentSandboxes", {
        className: "Sandbox",
        ...(image
          ? { image: image.imageRef }
          : {
              context: "apps/runner/bridge",
              dockerfile: new URL("../apps/runner/bridge/dev/Dockerfile", import.meta.url).pathname,
            }),
        instanceType: "standard-1",
        maxInstances: 10,
      }),
      WORKSPACE_CHECKPOINTS: checkpoints,
      REPOSITORY_AUTHORITY: cluster,
      JANITOR_AGENT_RUNNER_TOKEN: connection.token,
      REPOSITORY_SERVICE_TOKEN: connection.repositoryToken,
      ...(local && !liveModel
        ? { LOCAL_MODEL_TOKEN: "local-controlled-model" }
        : {
            JANITOR_AGENT_RUNNER_MODEL_API_KEY: requiredSecret(
              "JANITOR_AGENT_RUNNER_MODEL_API_KEY",
            ),
          }),
      ...(local ? { JANITOR_LOCAL_LIVE_MODEL: String(liveModel) } : {}),
      JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS: modelConfigurations,
      JANITOR_AGENT_RUNNER_RELEASE: Output.map(build.hash.output, (hash) => {
        if (!hash) throw new Error("Runner build did not produce a release hash")
        return hash
      }),
    },
  }).pipe(retain())
})
