import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { AlchemyContextLive } from "alchemy/AlchemyContext"
import { CredentialsStoreLive } from "alchemy/Auth/Credentials"
import { ProfileLive } from "alchemy/Auth/Profile"
import { Cli } from "alchemy/Cli/Cli"
import { execStack } from "alchemy/Cli/commands/deploy"
import { selectCli } from "alchemy/Cli/selectCli"
import { PlatformServices, runMain } from "alchemy/Util/PlatformServices"
import { destructiveChanges } from "./deployment-plan.ts"

const [stage, action, ...flags] = process.argv.slice(2)
if (
  !stage ||
  stage !== "production" ||
  !action ||
  !["plan", "deploy"].includes(action) ||
  flags.some((flag) => flag !== "--yes")
)
  throw new Error("Usage: deploy.ts production plan|deploy [--yes]")
const guardedCli = Layer.effect(
  Cli,
  Effect.gen(function* () {
    const delegate = yield* Cli
    return Cli.of({
      ...delegate,
      startApplySession: (plan) =>
        Effect.gen(function* () {
          const rejected = destructiveChanges(plan)
          if (rejected.length)
            return yield* Effect.die(new Error(`Production plan rejected: ${rejected.join(", ")}`))
          // Record identities and actions only: plan props/state can contain secrets.
          yield* Effect.sync(() => {
            const dirty =
              execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0
            if (dirty) throw new Error("Commit the release before deploying production")
            mkdirSync(".alchemy/releases", { recursive: true })
            writeFileSync(
              `.alchemy/releases/${stage}-${Date.now()}.json`,
              JSON.stringify(
                {
                  stage,
                  action,
                  kind: "apply-attempt",
                  node: process.version,
                  lockfileSha256: createHash("sha256")
                    .update(readFileSync("pnpm-lock.yaml"))
                    .digest("hex"),
                  commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
                  dirty,
                  resources: Object.entries(plan.resources).map(([id, node]) => ({
                    id,
                    action: node.action,
                  })),
                  deletions: Object.keys(plan.deletions),
                },
                null,
                2,
              ),
            )
          })
          return yield* delegate.startApplySession(plan)
        }),
    })
  }),
).pipe(Layer.provide(selectCli()))

const services = Layer.mergeAll(
  Layer.provideMerge(AlchemyContextLive, PlatformServices),
  Layer.provide(ProfileLive, PlatformServices),
  Layer.provide(CredentialsStoreLive, PlatformServices),
  FetchHttpClient.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
  guardedCli,
)
const program = Effect.acquireUseRelease(
  Effect.sync(() => {
    mkdirSync(".alchemy", { recursive: true })
    const lock = `.alchemy/deploy-${stage}.lock`
    mkdirSync(lock)
    return lock
  }),
  () =>
    execStack({
      main: "alchemy.run.ts",
      stage,
      envFile: Option.some(`.env.${stage}`),
      dryRun: action === "plan",
      destroy: false,
      yes: flags.includes("--yes"),
    }),
  (lock) => Effect.sync(() => rmSync(lock, { recursive: true })),
).pipe(Effect.provide(services), Effect.scoped)

runMain(program)
