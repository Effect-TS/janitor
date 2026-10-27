import { WorkerEntrypoint } from "cloudflare:workers"
import * as Effect from "effect/Effect"
import type { WorkspaceNamespace } from "../../PullRequestReview/Sandbox/WorkspaceClient.ts"
import {
  handleChatEgress,
  LookupFailed,
  type ChatEgress as ChatEgressContext,
  type GitHubNode,
  type GitHubTokens,
  type RepositoryInfo,
} from "./Egress.ts"
import {
  EGRESS_CONTROL_HEADER,
  type ChatEgressProps,
  type EgressAnswer,
  type EgressQuery,
} from "./Session.ts"

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
    return Effect.runPromise(handleChatEgress(request, makeEgress(props, workspace)))
  }
}

/** One request's egress context. Answers are cached for the request only. */
const makeEgress = (
  props: ChatEgressProps,
  workspace: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> },
): ChatEgressContext => {
  const answers = new Map<string, Effect.Effect<unknown, LookupFailed>>()
  const ask = (query: EgressQuery) => {
    const key = JSON.stringify(query)
    const cached = answers.get(key)
    if (cached !== undefined) return cached
    const asked = Effect.tryPromise({
      try: async () => {
        const response = await workspace.fetch("http://chat-egress/control", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [EGRESS_CONTROL_HEADER]: String(props.generation),
          },
          body: key,
        })
        if (!response.ok) throw new Error(`answered ${response.status}`)
        return (await response.json()) as EgressAnswer
      },
      catch: () => new LookupFailed({ reason: "the sandbox's workspace couldn't be reached" }),
    }).pipe(
      Effect.flatMap((answer) =>
        "ok" in answer
          ? Effect.succeed(answer.ok)
          : Effect.fail(new LookupFailed({ reason: answer.failed })),
      ),
      Effect.cached,
      Effect.runSync,
    )
    answers.set(key, asked)
    return asked
  }
  return {
    sessionId: props.sessionId,
    turnId: props.turnId,
    multicaToken: props.multicaToken,
    // A workspace that can't be reached hands out no token: the request goes without one.
    githubTokens: (owner) =>
      ask({ op: "tokens", owner }).pipe(
        Effect.map((tokens) => (tokens as GitHubTokens | null) ?? undefined),
        Effect.orElseSucceed(() => undefined),
      ),
    github: {
      repository: (repository) =>
        ask({ op: "repository", repository }).pipe(Effect.map((info) => info as RepositoryInfo)),
      branchRuled: (repository, branch) =>
        ask({ op: "branchRuled", repository, branch }).pipe(
          Effect.map((ruled) => ruled as boolean),
        ),
      node: (id) =>
        ask({ op: "node", id }).pipe(
          Effect.map((node) => (node as GitHubNode | null) ?? undefined),
        ),
    },
    upstream: (forwarded) =>
      Effect.tryPromise(() => fetch(forwarded)).pipe(
        Effect.orElseSucceed(
          () => new Response("janitor's egress proxy couldn't reach the host\n", { status: 502 }),
        ),
      ),
  }
}
