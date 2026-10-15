/**
 * The sandbox's egress policy (EFF-1646, EFF-1892). The workspace DO routes
 * every HTTP and HTTPS request the container makes to the `GitEgress`
 * entrypoint, which hands it here with the props it was registered with.
 */

/** What the workspace DO registers the egress intercepts with, one set per acquire. */
export interface EgressProps {
  readonly runId: string
  /** The pull request's base repository, `owner/name`. */
  readonly repo: string
  readonly prNumber: number
  /** A fresh installation token, `contents: read` on the base repository only. */
  readonly token: string
}

/** Package registries and the GitHub hosts git needs. Everything else gets 403. */
export const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
])

/** A GitHub owner or repository path segment. Anything encoded doesn't match. */
const NAME = /^[A-Za-z0-9._-]+$/

/**
 * Whether a request is one of git's two upload-pack requests on the base
 * repository: `GET /{owner}/{repo}(.git)/info/refs?service=git-upload-pack`
 * or `POST /{owner}/{repo}(.git)/git-upload-pack` over HTTPS. The URL's path
 * is already normalised, so `..` segments have been resolved.
 */
const isBaseRepoUploadPack = (method: string, url: URL, repo: string) => {
  if (url.protocol !== "https:" || url.hostname !== "github.com") return false
  const [empty, owner, name, ...rest] = url.pathname.split("/")
  if (empty !== "" || owner === undefined || name === undefined) return false
  if (!NAME.test(owner) || !NAME.test(name)) return false
  const target = `${owner}/${name.replace(/\.git$/i, "")}`.toLowerCase()
  if (target !== repo.toLowerCase()) return false
  const action = rest.join("/")
  if (action === "info/refs") {
    const service = url.searchParams.getAll("service")
    return method === "GET" && service.length === 1 && service[0] === "git-upload-pack"
  }
  return action === "git-upload-pack" && method === "POST"
}

/**
 * Applies the allowlist, drops any `Authorization` header the container sent,
 * adds the installation token to the base repository's upload-pack requests
 * only, and forwards without following redirects: git re-requests a redirect
 * target through this handler, which checks it again.
 */
export const handleEgress = (
  request: Request,
  props: EgressProps,
  upstream: (request: Request) => Promise<Response>,
): Promise<Response> => {
  const url = new URL(request.url)
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    return Promise.resolve(
      new Response(`egress to ${url.hostname} is not allowed\n`, { status: 403 }),
    )
  }
  const headers = new Headers(request.headers)
  headers.delete("authorization")
  if (isBaseRepoUploadPack(request.method, url, props.repo)) {
    headers.set("authorization", `Basic ${btoa(`x-access-token:${props.token}`)}`)
  }
  return upstream(new Request(request, { headers, redirect: "manual" }))
}
