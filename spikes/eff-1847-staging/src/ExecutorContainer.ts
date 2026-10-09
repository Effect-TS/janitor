import * as Cloudflare from "alchemy/Cloudflare"
import type * as Effect from "effect/Effect"

/**
 * The sandbox container that hosts clanka's AgentExecutor (EFF-1875). The
 * only container RPC method is `ping`; the executor protocol rides on the
 * container's plain `fetch` handler (see ExecutorContainer.runtime.ts).
 */
export class ExecutorContainer extends Cloudflare.Container<
  ExecutorContainer,
  { readonly ping: () => Effect.Effect<string> }
>()("Eff1847Executor") {}
