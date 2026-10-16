/**
 * The part of workerd's `cloudflare:workers` module janitor's own code uses.
 * The Worker bundler leaves the import to the runtime.
 */
declare module "cloudflare:workers" {
  export abstract class WorkerEntrypoint<Env = unknown, Props = unknown> {
    protected readonly ctx: { readonly props: Props }
    protected readonly env: Env
    constructor(ctx: unknown, env: Env)
    fetch?(request: Request): Response | Promise<Response>
  }
}
