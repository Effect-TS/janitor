import { apply } from "alchemy/Apply"
import { provideFreshArtifactStore } from "alchemy/Artifacts"
import * as Plan from "alchemy/Plan"
import * as Stack from "alchemy/Stack"
import { Stage } from "alchemy/Stage"
import * as State from "alchemy/State"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

/**
 * A stack with private in-memory state, deployed by planning and applying the
 * given resources against it. This is the `deploy` half of Alchemy's
 * `scratchStack`, which moved to `@alchemy.run/test`; the preview builds
 * janitor pins don't publish that package. Replace this with it once janitor
 * is back on npm releases.
 */
export const scratchStack = <ROut>(
  providers: Layer.Layer<ROut, never, Stack.StackServices>,
  name: string,
) => {
  const state = Layer.succeed(State.State, State.InMemoryService({}))
  return {
    deploy: <A, E>(effect: Effect.Effect<A, E, ROut | Stack.StackServices>) => {
      const deployed = effect.pipe(
        Stack.make({ name, providers, state }),
        Effect.flatMap((compiled) =>
          Plan.make(compiled).pipe(Effect.flatMap(apply), Effect.provide(compiled.services)),
        ),
        Effect.provideService(Stage, "test"),
        provideFreshArtifactStore,
      )
      // Planning and applying declare the CLI's services (credentials,
      // profiles, prompts), which local providers never reach. Alchemy's own
      // scratchStack drops them the same way.
      return deployed as Effect.Effect<
        Effect.Success<typeof deployed>,
        Effect.Error<typeof deployed>
      >
    },
  }
}
