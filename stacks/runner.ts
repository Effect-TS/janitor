import { runnerWorkerName } from "@janitor/cluster/Agent/RunnerBinding"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Command from "alchemy/Command"
import * as Effect from "effect/Effect"
import * as Config from "effect/Config"
import * as FileSystem from "effect/FileSystem"
import * as Output from "alchemy/Output"
import { retain } from "alchemy/RemovalPolicy"
import ClusterWorker from "@janitor/cluster/Worker"
import { deployment, requiredSecret, agentRunnerConnection } from "@janitor/cluster/Deployment"

// No new resource scope: existing Alchemy addresses and the Worker identity stay stable.
// The session class is new because containers can only be enabled on a class at creation;
// cutover deletes the previous class with its retired sessions.
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
  const build = yield* Command.Build("AgentRunnerBuild", {
    cwd: "apps/runner",
    command: local ? "vp run --no-cache build:dev" : "vp run --no-cache build",
    outdir: local ? "dist-dev" : "dist",
    memo: {
      include: [
        "src/**",
        "scripts/**",
        "package.json",
        "../../pnpm-lock.yaml",
        "../../pnpm-workspace.yaml",
        "../../patches/**",
        "dev/**",
      ],
    },
    timeout: "15 minutes",
  })
  const backupBucketName = local
    ? "janitor-workspace-checkpoints-local"
    : "janitor-workspace-checkpoints"
  const backups = yield* Cloudflare.R2.Bucket("AgentWorkspaceCheckpoints", {
    name: backupBucketName,
  }).pipe(retain())
  // Alchemy resolves both paths from the process working directory, not from each other.
  const containerContext = new URL("../apps/runner/container", import.meta.url).pathname
  const containerDockerfile = new URL(
    local ? "../apps/runner/container/dev/Dockerfile" : "../apps/runner/container/Dockerfile",
    import.meta.url,
  ).pathname
  return yield* Cloudflare.Worker("AgentRunner", {
    name: runnerWorkerName,
    main: Output.interpolate`${build.outdir}/worker.mjs`,
    bundle: false,
    ...(local ? { dev: { port: 8790, strictPort: true } } : { domain: `runner.${target.domain}` }),
    workersDev: false,
    compatibility: { date: local ? "2026-07-04" : "2026-09-05", flags: ["nodejs_compat"] },
    observability: { enabled: true },
    // Model streaming and tool coordination for a whole turn run inside one alarm handler.
    limits: { cpuMs: 300_000 },
    env: {
      // The session object owns its container: one sandbox per agent session.
      SESSIONS: Cloudflare.Container("AgentSessionSandboxes", {
        className: "SandboxSession",
        context: containerContext,
        dockerfile: containerDockerfile,
        instanceType: "standard-1",
        maxInstances: 10,
      }),
      BACKUP_BUCKET: backups,
      BACKUP_BUCKET_NAME: backupBucketName,
      REPOSITORY_AUTHORITY: cluster,
      JANITOR_AGENT_RUNNER_TOKEN: connection.token,
      REPOSITORY_SERVICE_TOKEN: connection.repositoryToken,
      ...(local
        ? {
            JANITOR_SANDBOX_LOCAL: "true",
            JANITOR_LOCAL_GIT_REMOTE: "/opt/janitor/fixture.git",
          }
        : {
            // Production backups upload straight from the container through presigned R2 URLs.
            CLOUDFLARE_ACCOUNT_ID: yield* Config.String("CLOUDFLARE_ACCOUNT_ID"),
            R2_ACCESS_KEY_ID: requiredSecret("JANITOR_SANDBOX_R2_ACCESS_KEY_ID"),
            R2_SECRET_ACCESS_KEY: requiredSecret("JANITOR_SANDBOX_R2_SECRET_ACCESS_KEY"),
          }),
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
