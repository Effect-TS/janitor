import * as Cloudflare from "alchemy/Cloudflare"
import * as Command from "alchemy/Command"
import * as Effect from "effect/Effect"
import * as Config from "effect/Config"
import * as FileSystem from "effect/FileSystem"
import * as Output from "alchemy/Output"
import { retain } from "alchemy/RemovalPolicy"
import ClusterWorker from "@janitor/cluster/Worker"
import { deployment, requiredSecret } from "@janitor/cluster/Deployment"

// No new resource scope: existing Alchemy addresses and namespace identities stay stable.
export const AgentRunner = Effect.gen(function* () {
  const target = yield* deployment
  const cluster = yield* ClusterWorker
  if (target.stage === "local") return undefined
  const fs = yield* FileSystem.FileSystem
  const modelConfigurations = yield* Config.String(
    "JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS",
  ).pipe(
    Config.withDefault(
      yield* fs
        .readFileString("apps/runner/model-configurations/openrouter-llama-3.1-8b.json")
        .pipe(Effect.orDie),
    ),
  )
  const build = yield* Command.Build("AgentRunnerBuild", {
    cwd: "apps/runner",
    command: "vp run --no-cache build:deploy",
    outdir: "dist",
    env: {
      // A prebuilt-image override is reserved for direct local build validation.
      JANITOR_DEPLOY_IMAGE: "",
      CLOUDFLARE_ACCOUNT_ID: yield* Config.String("CLOUDFLARE_ACCOUNT_ID"),
      CLOUDFLARE_API_TOKEN: yield* requiredSecret("CLOUDFLARE_API_TOKEN"),
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
      ],
    },
    timeout: "15 minutes",
  })
  const image = build.outdir.pipe(
    Output.mapEffect((directory) =>
      fs.readFileString(`${directory}/image-reference.txt`).pipe(Effect.orDie),
    ),
  )
  const checkpoints = yield* Cloudflare.R2.Bucket("AgentWorkspaceCheckpoints", {
    name: "janitor-workspace-checkpoints",
  }).pipe(retain())
  return yield* Cloudflare.Worker("AgentRunner", {
    name: "janitor-agent-runner",
    main: Output.interpolate`${build.outdir}/worker.mjs`,
    bundle: false,
    domain: `runner.${target.domain}`,
    workersDev: false,
    compatibility: { date: "2026-09-05", flags: ["nodejs_compat"] },
    observability: { enabled: true },
    env: {
      SESSIONS: Cloudflare.DurableObject("AgentSessions", { className: "SessionRunner" }),
      SANDBOXES: Cloudflare.Container("AgentSandboxes", {
        className: "Sandbox",
        image,
        instanceType: "standard-1",
        maxInstances: 10,
      }),
      WORKSPACE_CHECKPOINTS: checkpoints,
      REPOSITORY_AUTHORITY: cluster,
      JANITOR_AGENT_RUNNER_TOKEN: requiredSecret("JANITOR_AGENT_RUNNER_TOKEN"),
      REPOSITORY_SERVICE_TOKEN: requiredSecret("REPOSITORY_SERVICE_TOKEN"),
      JANITOR_AGENT_RUNNER_MODEL_API_KEY: requiredSecret("JANITOR_AGENT_RUNNER_MODEL_API_KEY"),
      JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS: modelConfigurations,
      JANITOR_AGENT_RUNNER_RELEASE: Output.map(build.hash.output, (hash) => {
        if (!hash) throw new Error("Runner build did not produce a release hash")
        return hash
      }),
    },
  }).pipe(retain())
})
