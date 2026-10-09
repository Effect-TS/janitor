import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Infisical from "alchemy/Infisical"
import * as Secrets from "alchemy/Secrets"
import { localState } from "alchemy/State"
import * as Effect from "effect/Effect"
import ExecutorContainerLive from "./src/ExecutorContainer.runtime.ts"
import StagingWorker from "./src/Worker.ts"

/**
 * EFF-1847 / EFF-1875 throwaway stack. Deploy and tear down only through
 * `scripts/deploy.sh deploy|destroy`, which pins the account and the `dev`
 * profile and refuses to run unless this stack keeps `localState()`.
 *
 * EFF-1875 runs it on janitor's production account (the only paid one), so
 * the state must stay local (never the shared state store) and nothing may
 * be adopted.
 */
export default Alchemy.Stack(
  "Eff1847Staging",
  {
    providers: Cloudflare.providers(),
    state: localState(),
    // OPENROUTER_API_KEY comes from janitor's development Infisical
    // environment (added for EFF-1655); DEPLOY_MARKER from the shell.
    secrets: () => [
      Infisical.Secrets({ project: "janitor", environment: "development" }),
      Secrets.ProcessEnv(),
    ],
  },
  Effect.gen(function* () {
    const worker = yield* StagingWorker
    return { url: worker.url }
  }).pipe(Effect.provide(ExecutorContainerLive)),
)
