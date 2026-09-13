import { ProtocolError } from "./Protocol.ts"
import { checksum } from "./WorkspaceCheckpoints.ts"
import type { RepositorySelection } from "./RepositoryWorkspace.ts"

export type CredentialPermission = "read" | "push" | "pull_request"
export interface RepositoryCredential {
  owner: string
  repo: string
  token?: string
  pullRequestNumber?: number
  appId?: string
}
export interface PublicationInput {
  title: string
  body: string
  base?: string
}
interface Plan extends PublicationInput {
  operationId: string
  callId?: string
  existing?: boolean
  repositoryId: string
  generation: number
  owner: string
  repo: string
  branch: string
  base: string
  phase: "preparing" | "conflict" | "prepared" | "pushing" | "pushed" | "creating" | "complete"
  prepareId?: string
  commit?: string
  baseCommit?: string
  remoteHead?: string | null
  number?: number
  url?: string
}
export interface PublicationDependencies {
  authorize(
    token: boolean,
    permission?: CredentialPermission,
    refresh?: boolean,
  ): Promise<RepositoryCredential>
  git<A>(action: string, input: unknown): Promise<A>
  checkpoint(): Promise<void>
  fetch(request: Request): Promise<Response>
  fence(): Promise<void>
}
const blocked = (message: string): never => {
  throw new ProtocolError("blocked", message)
}
const key = "_janitor_publication"
const hash = /^[a-f0-9]{40}$/
interface PullRequest {
  number: number
  state: string
  html_url: string
  head: { ref: string; sha: string; repo: { id: number } | null }
  base: { ref: string; sha: string; repo: { id: number } }
}
interface Association {
  number: number
  url: string
  owner: string
  repo: string
  branch: string
  base: string
  headRepositoryId: string | null
  headCommit: string
  baseCommit: string
}
const associationKey = "_janitor_existing_pr"
interface Notice {
  marker: string
  state: "uncertain" | "pending" | "sent"
  message: string
  appId: string
  retryAt?: number
}
const noticePrefix = `${key}_notice_`

/** One new-work publication per session. Intent always precedes an external write. */
export class Publication {
  constructor(
    private storage: DurableObjectStorage,
    private selected: RepositorySelection,
    private deps: PublicationDependencies,
  ) {}

  private async readPr(credential: RepositoryCredential, number: number): Promise<PullRequest> {
    const response = await this.deps.fetch(
      new Request(
        `https://api.github.com/repos/${credential.owner}/${credential.repo}/pulls/${number}`,
        {
          headers: {
            authorization: `Bearer ${credential.token}`,
            accept: "application/vnd.github+json",
            "user-agent": "Janitor",
          },
          signal: AbortSignal.timeout(20000),
          redirect: "manual",
        },
      ),
    )
    await this.deps.fence()
    if (!response.ok) blocked("Existing PR is unavailable; workspace changes are preserved")
    const pr = (await response.json()) as PullRequest
    if (
      pr.number !== number ||
      pr.state !== "open" ||
      String(pr.base?.repo?.id) !== this.selected.repositoryId ||
      !hash.test(pr.head?.sha) ||
      !hash.test(pr.base?.sha) ||
      typeof pr.head?.ref !== "string" ||
      typeof pr.base?.ref !== "string" ||
      pr.html_url !== `https://github.com/${credential.owner}/${credential.repo}/pull/${number}`
    )
      blocked("Existing PR identity is invalid or the PR is closed; work is preserved")
    return pr
  }

  /** Capture the PR's identities before any repository tool can run. */
  async workspace(): Promise<Association | null> {
    const saved = await this.storage.get<Association | null>(associationKey)
    if (saved !== undefined) return saved
    const credential = await this.deps.authorize(true, "read")
    let association: Association | null = null
    if (credential.pullRequestNumber !== undefined) {
      if (!Number.isSafeInteger(credential.pullRequestNumber) || credential.pullRequestNumber <= 0)
        blocked("Invalid existing PR number")
      const pr = await this.readPr(credential, credential.pullRequestNumber)
      association = {
        number: pr.number,
        url: pr.html_url,
        owner: credential.owner,
        repo: credential.repo,
        branch: pr.head.ref,
        base: pr.base.ref,
        headRepositoryId: pr.head.repo ? String(pr.head.repo.id) : null,
        headCommit: pr.head.sha,
        baseCommit: pr.base.sha,
      }
    }
    await this.deps.fence()
    await this.storage.put(associationKey, association)
    await this.storage.sync()
    return association
  }

  private async save(plan: Plan) {
    await this.deps.fence()
    await this.storage.put(key, plan)
    await this.storage.sync()
  }
  private async guardNotices() {
    const notices = await this.storage.list<Notice>({ prefix: noticePrefix })
    if ([...notices.values()].some((notice) => notice.state !== "sent"))
      blocked(
        "PR explanation delivery is unconfirmed. Use publish to reconcile it before further work.",
      )
  }
  async guard() {
    await this.guardNotices()
    const plan = await this.storage.get<Plan>(key)
    if (plan && plan.phase !== "complete" && plan.phase !== "conflict")
      blocked("Publication is pending. Use publish to reconcile it before further repository work.")
  }
  private async credential(plan: Plan, permission: CredentialPermission, refresh = false) {
    await this.deps.fence()
    if (
      plan.repositoryId !== this.selected.repositoryId ||
      plan.generation !== this.selected.generation
    )
      blocked("Publication session generation or repository changed")
    const credential = await this.deps.authorize(true, permission, refresh)
    if (credential.owner !== plan.owner || credential.repo !== plan.repo || !credential.token)
      blocked("Publication repository changed; reconcile its identity before writing")
    if (plan.existing && permission !== "pull_request") {
      const readCredential =
        permission === "read" ? credential : await this.deps.authorize(true, "read", true)
      const pr = await this.readPr(readCredential, plan.number!)
      if (
        pr.head.ref !== plan.branch ||
        pr.base.ref !== plan.base ||
        String(pr.head.repo?.id) !== plan.repositoryId
      )
        blocked(
          "The existing PR branch changed or is unavailable for writing. Edits are preserved; a separate proposal requires teammate direction.",
        )
    }
    return credential
  }
  private async api(plan: Plan, path: string, body?: unknown) {
    const credential = await this.credential(plan, "pull_request", true)
    if (body !== undefined && path === "/pulls") await this.save({ ...plan, phase: "creating" })
    return this.request(credential, path, body)
  }
  private async request(credential: RepositoryCredential, path: string, body?: unknown) {
    await this.deps.fence()
    const response = await this.deps.fetch(
      new Request(`https://api.github.com/repos/${credential.owner}/${credential.repo}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${credential.token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "Janitor",
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
        redirect: "manual",
      }),
    )
    await this.deps.fence()
    return response
  }
  private async inspectPush(plan: Plan) {
    const credential = await this.credential(plan, "read", true)
    return this.deps.git<{ contains: boolean; remoteHead: string | null }>("inspect", {
      ...credential,
      branch: plan.branch,
      base: plan.base,
      commit: plan.commit,
      existing: plan.existing,
    })
  }
  private async matchingPr(plan: Plan): Promise<Plan | undefined> {
    let match: { number: number; html_url: string } | undefined
    for (let page = 1; page <= 20; page++) {
      const response = await this.api(
        plan,
        `/pulls?state=all&head=${encodeURIComponent(`${plan.owner}:${plan.branch}`)}&per_page=100&page=${page}`,
      )
      if (!response.ok)
        blocked("Cannot inspect matching pull requests; publication remains pending")
      const prs = (await response.json()) as Array<{
        number: number
        html_url: string
        body: string | null
        head: { ref: string; repo: { id: number } | null }
        base: { ref: string; repo: { id: number } }
      }>
      if (!Array.isArray(prs)) blocked("Invalid pull request lookup; publication remains pending")
      for (const pr of prs) {
        if (pr.head?.ref !== plan.branch || String(pr.head.repo?.id) !== plan.repositoryId) continue
        if (
          pr.base?.ref !== plan.base ||
          String(pr.base.repo?.id) !== plan.repositoryId ||
          !pr.body?.includes(`<!-- janitor-publication:${plan.operationId} -->`)
        )
          blocked(
            "The designated branch already has a different pull request. Ask the teammate before proceeding.",
          )
        if (match && match.number !== pr.number)
          blocked("Multiple pull requests match this publication; reconcile before proceeding")
        if (
          !Number.isSafeInteger(pr.number) ||
          pr.number <= 0 ||
          pr.html_url !== `https://github.com/${plan.owner}/${plan.repo}/pull/${pr.number}`
        )
          blocked("Invalid pull request identity")
        match = pr
      }
      if (prs.length < 100) {
        if (!match) return
        // Git refs establish commit presence. PR head SHA can lag behind them.
        return { ...plan, phase: "complete", number: match.number, url: match.html_url }
      }
    }
    blocked("Pull request lookup exceeded its bounded page limit; no new PR was created")
  }
  async publish(input: PublicationInput, callId?: string) {
    const pending = await this.storage.get<Plan>(key)
    if (pending?.existing) {
      const notices = await this.storage.list<Notice>({ prefix: noticePrefix })
      for (const notice of notices.values()) {
        if (notice.state !== "sent")
          await this.explain(pending, notice.message).catch(() => undefined)
      }
      await this.guardNotices()
    }
    try {
      return await this.perform(input, callId)
    } catch (error) {
      const plan = await this.storage.get<Plan>(key)
      if (plan?.existing) {
        const message = error instanceof Error ? error.message : "Publication is unavailable"
        await this.explain(plan, message).catch(() => undefined)
      }
      throw error
    }
  }
  private async explain(plan: Plan, message: string) {
    // The intent precedes POST. An ambiguous reply permits lookup only, never reposting.
    const noticeKey = `${noticePrefix}${await checksum(message)}`
    let notice = await this.storage.get<Notice>(noticeKey)
    if (notice?.state === "sent") return
    if (notice?.retryAt !== undefined && notice.retryAt > Date.now()) return
    if (notice?.state === "uncertain") {
      for (let page = 1; page <= 20; page++) {
        const response = await this.api(
          plan,
          `/issues/${plan.number}/comments?per_page=100&page=${page}`,
        )
        if (!response.ok) {
          await this.deferNotice(noticeKey, notice, response)
          return
        }
        const comments = (await response.json()) as Array<{
          body: string
          user: { type: string }
          performed_via_github_app?: { id: number }
        }>
        if (!Array.isArray(comments)) return
        if (
          comments.some(
            (comment) =>
              comment.user?.type === "Bot" &&
              String(comment.performed_via_github_app?.id) === notice!.appId &&
              comment.body?.includes(notice!.marker),
          )
        ) {
          await this.deps.fence()
          await this.storage.put(noticeKey, { ...notice, state: "sent" })
          await this.storage.sync()
          return
        }
        if (comments.length < 100) return
      }
      return
    }
    // Obtain write authorization before recording an uncertain send.
    const credential = await this.credential(plan, "pull_request", true)
    if (!credential.appId) blocked("PR explanation needs the configured GitHub App identity")
    notice = {
      marker: notice?.marker ?? `<!-- janitor-pr-notice:${crypto.randomUUID()} -->`,
      state: "uncertain",
      message,
      appId: credential.appId!,
    }
    await this.deps.fence()
    await this.storage.put(noticeKey, notice)
    await this.storage.sync()
    const response = await this.request(credential, `/issues/${plan.number}/comments`, {
      body: `${message}\n\nWorkspace changes are preserved. Please clarify conflicts or restore branch access in the home thread. A separate proposal requires explicit teammate direction.\n\n${notice.marker}`,
    })
    if (response.ok) {
      await this.storage.put(noticeKey, { ...notice, state: "sent" })
      await this.storage.sync()
    } else if ([400, 401, 403, 404, 422, 429].includes(response.status)) {
      await this.deferNotice(noticeKey, { ...notice, state: "pending" }, response)
    }
  }
  private async deferNotice(noticeKey: string, notice: Notice, response: Response) {
    if (response.status === 429 || response.status === 403) {
      const retryAfter = response.headers.get("retry-after")
      const now = Date.now()
      const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000
      const retryAt =
        retryAfter !== null
          ? /^\d+$/.test(retryAfter)
            ? now + Number(retryAfter) * 1000
            : Date.parse(retryAfter)
          : reset > now
            ? reset
            : now + 60000
      notice = {
        ...notice,
        retryAt: Number.isFinite(retryAt) ? Math.max(now, retryAt) : now + 60000,
      }
    }
    await this.deps.fence()
    // The rejected-send state and its retry deadline commit together.
    await this.storage.put(noticeKey, notice)
    await this.storage.sync()
  }
  private async perform(input: PublicationInput, callId?: string) {
    let plan = await this.storage.get<Plan>(key)
    const association = await this.workspace()
    if (association && (!plan || (plan.phase === "complete" && plan.callId !== callId))) {
      plan = {
        ...input,
        ...association,
        operationId: await checksum(JSON.stringify(this.selected)),
        callId,
        existing: true,
        repositoryId: this.selected.repositoryId,
        generation: this.selected.generation,
        phase: "conflict",
      }
      await this.save(plan)
    }
    if (plan?.existing && input.base !== undefined && input.base !== plan.base)
      blocked("The existing PR base cannot be changed through publish")
    if (!plan) {
      const credential = await this.deps.authorize(true, "read")
      const response = await this.deps.fetch(
        new Request(`https://api.github.com/repos/${credential.owner}/${credential.repo}`, {
          headers: {
            authorization: `Bearer ${credential.token}`,
            accept: "application/vnd.github+json",
            "user-agent": "Janitor",
          },
          signal: AbortSignal.timeout(20000),
          redirect: "manual",
        }),
      )
      if (!response.ok) blocked("Repository metadata is unavailable; committed work is preserved")
      const repository = (await response.json()) as { id: number; default_branch: string }
      if (String(repository.id) !== this.selected.repositoryId)
        blocked("GitHub repository identity changed")
      const operationId = await checksum(JSON.stringify(this.selected))
      plan = {
        ...input,
        operationId,
        repositoryId: this.selected.repositoryId,
        generation: this.selected.generation,
        owner: credential.owner,
        repo: credential.repo,
        branch: `janitor/${operationId}`,
        base: input.base ?? repository.default_branch,
        phase: "conflict",
      }
    }
    await this.deps.fence()
    if (plan.phase === "complete") return this.result(plan)
    if (plan.phase === "conflict" || plan.phase === "preparing") {
      const credential = await this.credential(plan, "read", true)
      if (plan.phase === "conflict")
        plan = {
          ...plan,
          title: input.title,
          body: input.body,
          base: input.base ?? plan.base,
          phase: "preparing",
          prepareId: crypto.randomUUID(),
        }
      await this.save(plan)
      const prepared = await this.deps.git<{
        status: string
        message?: string
        commit: string
        baseCommit: string
        remoteHead: string | null
      }>("prepare", {
        ...credential,
        branch: plan.branch,
        base: plan.base,
        prepareId: plan.prepareId,
        existing: plan.existing,
      })
      if (prepared.status === "conflict" || prepared.status === "blocked") {
        plan = { ...plan, phase: "conflict" }
        await this.save(plan)
        blocked(prepared.message ?? "Human changes conflict; ask the teammate before publishing")
      }
      if (
        prepared.status !== "prepared" ||
        !hash.test(prepared.commit) ||
        !hash.test(prepared.baseCommit) ||
        (prepared.remoteHead !== null && !hash.test(prepared.remoteHead))
      )
        blocked("Invalid prepared Git identity")
      // Merged human commits and the designated local branch must survive a restart before push.
      await this.deps.checkpoint()
      plan = {
        ...plan,
        phase: "prepared",
        commit: prepared.commit,
        baseCommit: prepared.baseCommit,
        remoteHead: prepared.remoteHead,
      }
      await this.save(plan)
    }
    if (plan.phase === "prepared") {
      const credential = await this.credential(plan, "push", true)
      plan = { ...plan, phase: "pushing" }
      await this.save(plan)
      const response = await this.deps
        .git<{ status: string }>("push", {
          ...credential,
          branch: plan.branch,
          base: plan.base,
          commit: plan.commit,
          remoteHead: plan.remoteHead,
          existing: plan.existing,
        })
        .catch(() => undefined)
      if (response?.status === "stale" || response?.status === "conflict") {
        await this.save({ ...plan, phase: "conflict" })
        blocked(
          "The remote branch changed. Retry publish to fetch and incorporate human commits; no force push was made.",
        )
      }
      if (response?.status === "unconfirmed" && !(await this.inspectPush(plan)).contains) {
        // The bridge has confirmed that this invocation exited. Reuse the same
        // commit and branch after checking refs, with refreshed credentials.
        await this.save({ ...plan, phase: "prepared" })
        blocked(
          "Git could not publish the branch. Work is preserved; restore write access and retry publish with the same commit and branch.",
        )
      }
      // Even a successful reply is checked against fetched history before PR creation.
    }
    if (plan.phase === "pushing" || plan.phase === "pushed" || plan.phase === "creating") {
      if (!(await this.inspectPush(plan)).contains)
        blocked(
          "Push outcome is unconfirmed. Committed work is preserved; use publish to inspect the same branch again.",
        )
      if (plan.phase === "pushing") {
        plan = { ...plan, phase: "pushed" }
        await this.save(plan)
      }
      if (plan.existing) {
        plan = { ...plan, phase: "complete", callId }
        await this.save(plan)
        return this.result(plan)
      }
      const match = await this.matchingPr(plan)
      if (match) {
        await this.save(match)
        return this.result(match)
      }
      if (plan.phase === "creating")
        blocked(
          "PR creation outcome is unconfirmed. Metadata may lag; use publish to inspect the same operation again.",
        )
      plan = { ...plan, phase: "creating" }
      const response = await this.api(plan, "/pulls", {
        title: plan.title,
        body: `${plan.body}\n\n<!-- janitor-publication:${plan.operationId} -->`,
        head: plan.branch,
        base: plan.base,
        maintainer_can_modify: true,
      }).catch(() => undefined)
      if (response && [401, 403, 429].includes(response.status)) {
        await this.save({ ...plan, phase: "pushed" })
        blocked(
          "GitHub denied PR creation. The branch and workspace are preserved; restore write access and retry publish.",
        )
      }
      if (response && [400, 404, 422].includes(response.status)) {
        await this.save({ ...plan, phase: "conflict" })
        blocked(
          "GitHub rejected PR validation. Work is preserved. Review the changes, base and title, then retry publish on the same branch.",
        )
      }
      // A lost POST reply never authorizes another POST. Both successful and lost
      // replies are adopted only through the same stable operation marker.
      const published = await this.matchingPr(plan)
      if (!published)
        return blocked(
          "PR creation outcome is unconfirmed. Work is preserved; retry publish to reconcile, without creating a competing PR.",
        )
      await this.save(published)
      return this.result(published)
    }
    return blocked("Publication remains pending")
  }
  private result(plan: Plan) {
    return {
      content: `${plan.title}\n\n${plan.body}\n\nReview: ${plan.url}\nBranch: ${plan.branch}. Merge remains a teammate decision.`,
      metadata: {
        publication: {
          operationId: plan.operationId,
          repositoryId: plan.repositoryId,
          number: plan.number!,
          url: plan.url!,
          branch: plan.branch,
          base: plan.base,
          commit: plan.commit!,
          title: plan.title,
          body: plan.body,
        },
      },
    }
  }
}
