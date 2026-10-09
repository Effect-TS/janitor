/**
 * The sandbox egress allowlist from EFF-1646: package registries and the
 * GitHub hosts git needs. The workspace DO hands every intercepted HTTP and
 * HTTPS request from the container to this Worker's default entrypoint; the
 * front door sends anything whose host is not the Worker's own here.
 */
export const ALLOWED_HOSTS: ReadonlyArray<string> = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
]

export const isEgress = (request: Request) => !new URL(request.url).hostname.endsWith(".workers.dev")

export const handleEgress = async (request: Request): Promise<Response> => {
  const url = new URL(request.url)
  const allowed = ALLOWED_HOSTS.includes(url.hostname)
  console.log(`[egress] ${allowed ? "allow" : "deny"} ${request.method} ${url.protocol}//${url.host}${url.pathname.slice(0, 80)}`)
  if (!allowed) {
    return new Response(`egress denied by allowlist: ${url.hostname}\n`, { status: 403, headers: { "x-egress": "denied" } })
  }
  return fetch(request)
}
