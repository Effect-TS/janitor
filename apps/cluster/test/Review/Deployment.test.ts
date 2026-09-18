import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, it } from "@effect/vitest"
import * as Alchemy from "alchemy"
import { AlchemyContext } from "alchemy/AlchemyContext"
import { provideFreshArtifactStore } from "alchemy/Artifacts"
import { LoggingCli } from "alchemy/Cli/LoggingCli"
import * as Cloudflare from "alchemy/Cloudflare"
import { evalStack } from "alchemy/Stack"
import { inMemoryState } from "alchemy/State"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import { issueReviewDeploymentEnv, issueReviewEnabled } from "../../src/Review/Gate.ts"

for (const enabled of [false, true]) {
  it.effect(`registers review availability ${enabled} in the Worker deployment bindings`, () => {
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
    const stack = Alchemy.Stack(
      "ReviewConfigTest",
      { providers: Cloudflare.providers(), state: inMemoryState() },
      ReviewConfigWorker,
    )
    return evalStack(
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
              text: String(enabled),
            },
          )
        }),
      { stage: "test" },
    ).pipe(
      provideFreshArtifactStore,
      Effect.provide([
        LoggingCli,
        inMemoryState(),
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ JANITOR_ISSUE_REVIEW_ENABLED: String(enabled) }),
        ),
      ]),
      Effect.provideService(AlchemyContext, {
        dotAlchemy: "/tmp/janitor-review-config-test",
        dev: false,
        adopt: false,
      }),
      Effect.provide(NodeServices.layer),
    )
  })
}
