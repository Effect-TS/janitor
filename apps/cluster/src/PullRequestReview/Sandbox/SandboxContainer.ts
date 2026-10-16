import * as Cloudflare from "alchemy/Cloudflare"

/**
 * The PR review sandbox: clanka's executor and the checkout, one container
 * per run, owned by the run's workspace Durable Object. Its whole surface is
 * the HTTP app on port 3000 (`ContainerApp.ts`); the runtime is in
 * `SandboxContainer.runtime.ts`, kept apart so the Worker bundle doesn't pull
 * in clanka.
 */
export class SandboxContainer extends Cloudflare.Container<SandboxContainer, {}>()(
  "PullRequestReviewSandbox",
) {}
