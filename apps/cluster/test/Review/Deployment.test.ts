import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, it } from "@effect/vitest"
import * as Alchemy from "alchemy"
import { AlchemyContext } from "alchemy/AlchemyContext"
import { provideFreshArtifactStore } from "alchemy/Artifacts"
import { LoggingCli } from "alchemy/Cli/LoggingCli"
import * as Interaction from "alchemy/Interaction"
import * as Cloudflare from "alchemy/Cloudflare"
import { evalStack } from "alchemy/Stack"
import { inMemoryState } from "alchemy/State"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import { issueReviewDeploymentEnv, issueReviewEnabled } from "../../src/Review/Gate.ts"

for (const enabled of [false, true]) {
  for (const phase of ["plan", "runtime"] as const) {
    it.effect(`loads review availability ${enabled} during ${phase}`, () =>
      Effect.gen(function* () {
        const deploymentEnv = yield* issueReviewDeploymentEnv.pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({ JANITOR_ISSUE_REVIEW_ENABLED: String(enabled) }),
            ),
          ),
        )
        class ReviewConfigWorker extends Cloudflare.Worker<ReviewConfigWorker>()(
          "ReviewConfig",
          Effect.gen(function* () {
            return { main: import.meta.url, env: yield* issueReviewDeploymentEnv }
          }),
          Effect.gen(function* () {
            assert.strictEqual(yield* issueReviewEnabled, enabled)
            return {}
          }),
        ) {}
        // The fixed ConfigProvider below hides the process environment (including
        // CI) from Alchemy, which would otherwise fall back to the profile store
        // that CI runners do not have. Fake environment credentials keep credential
        // resolution lazy; nothing here contacts Cloudflare.
        const cloudflareEnv = {
          CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
          CLOUDFLARE_API_TOKEN: "test",
        }
        const stack = Alchemy.Stack(
          "ReviewConfigTest",
          { providers: Cloudflare.providers(), state: inMemoryState() },
          ReviewConfigWorker,
        )
        return yield* evalStack(
          stack,
          (compiled) =>
            Effect.sync(() => {
              // Init-only Config reads land in runtime env after binding registration.
              // Checking the bindings catches flag changes that would otherwise deploy as noop.
              const bindings: ReadonlyArray<{ readonly data: Cloudflare.Worker["Binding"] }> =
                Object.values(compiled.bindings).flat()
              assert.deepInclude(
                bindings.flatMap((binding) => binding.data.bindings ?? []),
                {
                  type: "plain_text",
                  name: "JANITOR_ISSUE_REVIEW_ENABLED",
                  text: deploymentEnv.JANITOR_ISSUE_REVIEW_ENABLED,
                },
              )
            }),
          { stage: "test" },
        ).pipe(
          provideFreshArtifactStore,
          Effect.provideService(Cloudflare.Workers.WorkerEnvironment, deploymentEnv),
          Effect.provide([
            LoggingCli,
            Interaction.layerNonInteractive(),
            inMemoryState(),
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                ...cloudflareEnv,
                ALCHEMY_PHASE: phase,
                ...(phase === "plan"
                  ? { JANITOR_ISSUE_REVIEW_ENABLED: String(enabled) }
                  : deploymentEnv),
              }),
            ),
          ]),
          Effect.provideService(AlchemyContext, {
            dotAlchemy: "/tmp/janitor-review-config-test",
            dev: false,
            adopt: false,
          }),
          Effect.provide(NodeServices.layer),
        )
      }),
    )
  }
}
