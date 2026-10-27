import { WorkerEntrypoint } from "cloudflare:workers"
import * as Effect from "effect/Effect"
import type { WorkspaceNamespace } from "../../PullRequestReview/Sandbox/WorkspaceClient.ts"
import { makeEgressContext } from "./Client.ts"
import { handleChatEgress } from "./Egress.ts"
import type { ChatEgressProps } from "./Session.ts"

/**
 * The entrypoint every chat sandbox egress intercept targets (EFF-3017),
 * never the Worker's `default`, so the front door can't be reached from
 * inside the container. The chat workspace DO registers it through
 * `ctx.exports.ChatEgress({ props })` at each acquire.
 *
 * The policy runs here, so request and response bodies stream straight
 * through. Tokens and GitHub lookups come from the session's workspace,
 * which mints and caches them for the acquire.
 *
 * Only the Worker bundle loads this module: the generated entry re-exports
 * it (see `exportChatEgress` in `WorkspaceObject.ts`), because
 * `cloudflare:workers` doesn't exist where alchemy plans the deployment.
 */
export class ChatEgress extends WorkerEntrypoint<
  { readonly ChatWorkspace: WorkspaceNamespace },
  ChatEgressProps
> {
  override fetch(request: Request): Promise<Response> {
    const props = this.ctx.props
    const workspace = this.env.ChatWorkspace.getByName(props.sessionId)
    return Effect.runPromise(handleChatEgress(request, makeEgressContext(props, workspace)))
  }
}
