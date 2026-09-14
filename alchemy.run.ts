import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Command from "alchemy/Command"
import * as Docker from "alchemy/Docker"
import * as Neon from "alchemy/Neon"
import * as Provider from "alchemy/Provider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Config from "effect/Config"
import * as FileSystem from "effect/FileSystem"
import * as Output from "alchemy/Output"
import { retain } from "alchemy/RemovalPolicy"

import { JanitorDatabase } from "@janitor/cluster/Database"
import ClusterWorker from "@janitor/cluster/Worker"
import { deployment, requiredSecret } from "@janitor/cluster/Deployment"
import { Stage } from "alchemy/Stage"
import { cloudflareProviders } from "./deployment/CloudflareProviders.ts"

const WEBSITE_DEV_PORT = 1337

const DockerProviders = Layer.effect(
  Docker.Providers,
  Provider.collection([Docker.Container, Docker.Image]),
).pipe(
  Layer.provide([Docker.ContainerProvider(), Docker.ImageProvider()]),
  Layer.provideMerge(Docker.DockerLive),
)

const Providers = Layer.mergeAll(
  cloudflareProviders(),
  Command.providers(),
  DockerProviders,
  Neon.providers(),
)

export default Alchemy.Stack(
  "Janitor",
  {
    providers: Providers,
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const target = yield* deployment
    const stage = yield* Stage
    if (target.stage !== "local" && stage !== target.stage)
      return yield* Effect.die(new Error("JANITOR_STAGE must match the Alchemy --stage argument"))
    const database = yield* JanitorDatabase
    const cluster = yield* ClusterWorker

    // Keep the runner's Effect/OpenCode graph isolated. Alchemy uploads the
    // completed ESM bundle and owns its bindings, storage and container image.
    const runner =
      target.stage === "local"
        ? undefined
        : yield* Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const modelConfigurations = yield* Config.String(
              "JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS",
            ).pipe(
              Config.withDefault(
                yield* fs
                  .readFileString("runner/model-configurations/openrouter-llama-3.1-8b.json")
                  .pipe(Effect.orDie),
              ),
            )
            const build = yield* Command.Build("AgentRunnerBuild", {
              cwd: "runner",
              command: "vp run build:deploy",
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
                  "pnpm-lock.yaml",
                  "pnpm-workspace.yaml",
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
                JANITOR_AGENT_RUNNER_MODEL_API_KEY: requiredSecret(
                  "JANITOR_AGENT_RUNNER_MODEL_API_KEY",
                ),
                JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS: modelConfigurations,
                JANITOR_AGENT_RUNNER_RELEASE: Output.map(build.hash.output, (hash) => {
                  if (!hash) throw new Error("Runner build did not produce a release hash")
                  return hash
                }),
              },
            }).pipe(retain())
          })

    const website = yield* Cloudflare.Website.Foldkit("Website", {
      rootDir: new URL("./apps/web", import.meta.url).pathname,
      ...(target.stage === "local" ? {} : { domain: target.domain }),
      workersDev: false,
      dev: { port: WEBSITE_DEV_PORT, strictPort: true },
    })

    return {
      databaseId: database.databaseId,
      apiUrl: cluster.url,
      runnerUrl: runner?.url,
      url: website.url,
    }
  }),
)
