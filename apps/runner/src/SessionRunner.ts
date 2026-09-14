import { DurableObject } from "cloudflare:workers"
import { SessionController, type RunnerEnv } from "./SessionController.ts"
export { DEFAULT_OPTIONS, type RunnerEnv, type RunnerOptions } from "./SessionController.ts"

/** Native Cloudflare export. Each object owns one composition of the runner's Effect services. */
export class SessionRunner extends DurableObject<RunnerEnv> {
  private readonly session: SessionController
  constructor(ctx: DurableObjectState, env: RunnerEnv) {
    super(ctx, env)
    this.session = this.makeController(ctx, env)
  }
  protected makeController(ctx: DurableObjectState, env: RunnerEnv): SessionController {
    return new SessionController(ctx, env)
  }
  override fetch(request: Request) {
    return this.session.fetch(request)
  }
  override alarm() {
    return this.session.alarm()
  }
}
