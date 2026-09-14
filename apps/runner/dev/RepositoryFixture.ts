/** Disposable GitHub HTTP fixture shared by local development and native runner tests. */
export const makeRepositoryFixture = async (
  initial: Record<string, string> = {
    "README.md": "Validation code: apricot-47\n",
    "NOTES.md": "Validation code: cobalt-29\n",
  },
) => {
  const encode = new TextEncoder()
  const hash = async (input: Uint8Array) =>
    Array.from(new Uint8Array(await crypto.subtle.digest("SHA-1", new Uint8Array(input))), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")
  const blobs = new Map<string, Uint8Array>()
  const trees = new Map<
    string,
    Array<{ path: string; sha: string; mode: string; type: string; size: number }>
  >()
  const commits = new Map<
    string,
    { sha: string; tree: { sha: string }; parents: Array<{ sha: string }> }
  >()
  const refs = new Map<string, string>()
  const prs: Array<{
    number: number
    state: string
    html_url: string
    body: string
    head: { ref: string; sha: string | undefined; repo: { id: number } | null }
    base: { ref: string; sha: string | undefined; repo: { id: number } }
  }> = []
  const requests: Array<{ method: string; path: string; body: unknown }> = []
  let fail: { method: string; path: string; status: number; after: boolean } | undefined
  const blob = async (bytes: Uint8Array) => {
    const header = encode.encode(`blob ${bytes.length}\0`)
    const all = new Uint8Array(header.length + bytes.length)
    all.set(header)
    all.set(bytes, header.length)
    const sha = await hash(all)
    blobs.set(sha, bytes)
    return sha
  }
  const tree = async (entries: NonNullable<ReturnType<typeof trees.get>>) => {
    const sha = await hash(
      encode.encode(JSON.stringify(entries.sort((a, b) => a.path.localeCompare(b.path)))),
    )
    trees.set(sha, entries)
    return sha
  }
  const commit = async (input: { tree: string; parents: string[]; [key: string]: unknown }) => {
    const sha = await hash(encode.encode(JSON.stringify(input)))
    commits.set(sha, {
      sha,
      tree: { sha: input.tree },
      parents: input.parents.map((sha) => ({ sha })),
    })
    return sha
  }
  const advance = async (changes: Record<string, string | null>, branch = "main") => {
    const parent = refs.get(branch)
    const entries = new Map(
      (parent ? trees.get(commits.get(parent)!.tree.sha)! : []).map((entry) => [entry.path, entry]),
    )
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) entries.delete(path)
      else {
        const bytes = encode.encode(content)
        entries.set(path, {
          path,
          sha: await blob(bytes),
          mode: "100644",
          type: "blob",
          size: bytes.length,
        })
      }
    }
    const sha = await commit({
      tree: await tree([...entries.values()]),
      parents: parent ? [parent] : [],
      message: "Fixture update",
    })
    refs.set(branch, sha)
    return sha
  }
  await advance(initial)
  const contains = (ancestor: string, head: string): boolean =>
    head === ancestor ||
    (commits.get(head)?.parents.some((parent) => contains(ancestor, parent.sha)) ?? false)
  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url),
      path = decodeURIComponent(url.pathname.replace("/repos/fixture/fixture", ""))
    const body =
      request.method === "GET" ? undefined : ((await request.json()) as Record<string, any>)
    requests.push({ method: request.method, path, body })
    const matchingFailure =
      fail && request.method === fail.method && path === fail.path ? fail : undefined
    if (matchingFailure) {
      fail = undefined
      if (!matchingFailure.after) return Response.json({}, { status: matchingFailure.status })
    }
    const reply = (value: unknown, status = 200) =>
      matchingFailure
        ? Response.json({}, { status: matchingFailure.status })
        : Response.json(value, { status })
    if (path === "") return reply({ id: 123, default_branch: "main" })
    if (path.startsWith("/git/ref/heads/")) {
      const branch = path.slice("/git/ref/heads/".length),
        sha = refs.get(branch)
      return sha
        ? reply({ ref: `refs/heads/${branch}`, object: { type: "commit", sha } })
        : reply({}, 404)
    }
    if (path === "/git/blobs" && body) {
      const bytes =
        body.encoding === "base64"
          ? Uint8Array.from(atob(body.content), (c) => c.charCodeAt(0))
          : encode.encode(body.content)
      return reply({ sha: await blob(bytes) }, 201)
    }
    if (path.startsWith("/git/blobs/")) {
      const sha = path.split("/").at(-1)!,
        bytes = blobs.get(sha)
      if (!bytes) return reply({}, 404)
      let binary = ""
      for (const byte of bytes) binary += String.fromCharCode(byte)
      return reply({ sha, size: bytes.length, encoding: "base64", content: btoa(binary) })
    }
    if (path === "/git/trees" && body) {
      const entries = new Map((trees.get(body.base_tree) ?? []).map((entry) => [entry.path, entry]))
      for (const entry of body.tree) {
        if (entry.sha === null) entries.delete(entry.path)
        else entries.set(entry.path, { ...entry, size: blobs.get(entry.sha)?.length ?? 0 })
      }
      return reply({ sha: await tree([...entries.values()]) }, 201)
    }
    if (path.startsWith("/git/trees/")) {
      const sha = path.split("/").at(-1)!
      return trees.has(sha)
        ? reply({ sha, truncated: false, tree: trees.get(sha) })
        : reply({}, 404)
    }
    if (path === "/git/commits" && body)
      return reply({ sha: await commit(body as Parameters<typeof commit>[0]) }, 201)
    if (path.startsWith("/git/commits/")) {
      const value = commits.get(path.split("/").at(-1)!)
      return reply(value ?? {}, value ? 200 : 404)
    }
    if (path === "/git/refs" && body) {
      const branch = body.ref.replace(/^refs\/heads\//, "")
      if (refs.has(branch)) return reply({}, 422)
      refs.set(branch, body.sha)
      return reply({ object: { sha: body.sha } }, 201)
    }
    if (path.startsWith("/git/refs/heads/") && body) {
      const branch = path.slice("/git/refs/heads/".length),
        old = refs.get(branch)
      if (!old || body.force !== false || !contains(old, body.sha)) return reply({}, 422)
      refs.set(branch, body.sha)
      return reply({ object: { sha: body.sha } })
    }
    if (path.startsWith("/compare/")) {
      const [base, head] = path.slice(9).split("...")
      return reply({
        status: base === head ? "identical" : contains(base!, head!) ? "ahead" : "diverged",
      })
    }
    if (path === "/pulls" && request.method === "POST" && body) {
      const value = {
        number: prs.length + 1,
        state: "open",
        html_url: `https://github.com/fixture/fixture/pull/${prs.length + 1}`,
        body: body.body,
        head: { ref: body.head, sha: refs.get(body.head), repo: { id: 123 } },
        base: { ref: body.base, sha: refs.get(body.base), repo: { id: 123 } },
      }
      prs.push(value)
      return reply(value, 201)
    }
    if (path === "/pulls")
      return reply(
        prs.filter(
          (pr: any) =>
            !url.searchParams.get("head") ||
            url.searchParams.get("head") === `fixture:${pr.head.ref}`,
        ),
      )
    if (/^\/pulls\/\d+$/.test(path)) {
      const pr = prs[Number(path.split("/").at(-1)) - 1]
      return reply(pr ?? {}, pr ? 200 : 404)
    }
    if (path.endsWith("/comments")) return reply([])
    return reply({ error: "Unknown fixture route", path }, 404)
  }
  return {
    fetch: handler,
    requests,
    advance,
    refs,
    prs,
    failNext: (value: NonNullable<typeof fail>) => {
      fail = value
    },
    read: (path: string, branch = "main") => {
      const head = refs.get(branch)
      const entry =
        head && trees.get(commits.get(head)!.tree.sha)?.find((entry) => entry.path === path)
      return entry ? new TextDecoder().decode(blobs.get(entry.sha)) : undefined
    },
  }
}
