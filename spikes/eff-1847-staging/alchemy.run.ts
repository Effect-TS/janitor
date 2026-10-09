import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Infisical from "alchemy/Infisical"
import * as Secrets from "alchemy/Secrets"
import { localState } from "alchemy/State"
import * as Effect from "effect/Effect"
import StagingWorker from "./src/Worker.ts"

/**
 * EFF-1847 throwaway staging stack. Deploy with
 *
 *   EXECUTOR_URL=https://<quick-tunnel>.trycloudflare.com \
 *   alchemy deploy --stage staging --yes --no-input
 *
 * and tear down with `alchemy destroy --stage staging --yes --no-input`.
 * `scripts/deploy.sh` refuses any account other than the staging one.
 */
export default Alchemy.Stack(
  "Eff1847Staging",
  {
    providers: Cloudflare.providers(),
    state: localState(),
    // OPENROUTER_API_KEY comes from janitor's development Infisical
    // environment (added for EFF-1655); EXECUTOR_URL and DEPLOY_MARKER from
    // the shell.
    secrets: () => [
      Infisical.Secrets({ project: "janitor", environment: "development" }),
      Secrets.ProcessEnv(),
    ],
  },
  Effect.gen(function* () {
    const worker = yield* StagingWorker
    return { url: worker.url }
  }),
)
