import { WorkerEntrypoint } from "cloudflare:workers"
import { handleEgress, type EgressProps } from "./Egress.ts"

/**
 * The entrypoint every sandbox egress intercept targets, never the Worker's
 * `default`, so the front door can't be reached from inside the container.
 * The workspace DO registers it through `ctx.exports.GitEgress({ props })`.
 *
 * Only the Worker bundle loads this module: the generated entry re-exports it
 * (see `exportGitEgress` in `WorkspaceObject.ts`), because `cloudflare:workers`
 * doesn't exist where alchemy plans the deployment.
 */
export class GitEgress extends WorkerEntrypoint<unknown, EgressProps> {
  override fetch(request: Request): Promise<Response> {
    return handleEgress(request, this.ctx.props, (forwarded) => fetch(forwarded))
  }
}
