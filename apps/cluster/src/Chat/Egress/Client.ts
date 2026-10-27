import * as Effect from "effect/Effect"
import {
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
 * One request's egress context, as the `ChatEgress` entrypoint builds it:
 * tokens and GitHub lookups come from the session's workspace through
 * control requests, answers are cached for the request only, and the
 * forwarded request goes out through the global `fetch`.
 */
export const makeEgressContext = (
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
