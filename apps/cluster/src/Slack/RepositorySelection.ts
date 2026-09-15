import type { RepositoryInferenceResult } from "../Agent/RunnerProtocol.ts"

export interface RepositoryCandidate {
  readonly repository_id: string
  readonly owner: string
  readonly repo: string
}
export interface Selection {
  readonly repositoryId: string
  readonly pr: string | null
  readonly reason: string
}

/** Explicit references override shorthand and inference. Later explicit instructions clarify earlier ones. */
export const selectRepository = (
  texts: ReadonlyArray<string>,
  repositories: ReadonlyArray<RepositoryCandidate>,
  preferredOrganization: string,
): Selection | Extract<RepositoryInferenceResult, { kind: "clarification" }> | null => {
  let explicit: Selection | Extract<RepositoryInferenceResult, { kind: "clarification" }> | null =
    null
  for (const text of texts) {
    const references = [
      ...text.matchAll(
        /(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(pull|issues)\/(\d+))?/g,
      ),
    ].filter(
      (ref) =>
        ref[0].startsWith("https://github.com/") ||
        repositories.some(
          (r) =>
            r.owner.toLowerCase() === ref[1]!.toLowerCase() ||
            r.repo.toLowerCase() === ref[2]!.toLowerCase(),
        ),
    )
    if (references.length === 0) continue
    const matches = references.map((ref) => ({
      repository: repositories.find(
        (r) =>
          r.owner.toLowerCase() === ref[1]!.toLowerCase() &&
          r.repo.toLowerCase() === ref[2]!.toLowerCase(),
      ),
      pr: ref[3] === "pull" ? BigInt(ref[4]!).toString() : null,
    }))
    const ids = new Set(matches.map((m) => m.repository?.repository_id))
    const prs = new Set(matches.flatMap((m) => (m.pr === null ? [] : [m.pr])))
    if (ids.has(undefined) || ids.size !== 1 || prs.size > 1) {
      explicit = {
        kind: "clarification",
        question:
          "Which connected repository and PR should I use? The references do not identify one target.",
      }
      continue
    }
    const repositoryId = matches[0]!.repository!.repository_id
    const pr: string | null =
      prs.size === 1
        ? [...prs][0]!
        : explicit !== null &&
            "repositoryId" in explicit &&
            "pr" in explicit &&
            explicit.repositoryId === repositoryId
          ? explicit.pr
          : null
    explicit = { repositoryId, pr, reason: "Selected from your explicit repository reference." }
  }
  if (explicit !== null) return explicit
  // Match whole repository names only; ordinary fragments such as 'effectively' do not select 'effect'.
  for (const text of [...texts].reverse()) {
    const words = new Set(text.toLowerCase().match(/[a-z0-9_.-]+/g) ?? [])
    const matches = repositories.filter((r) => words.has(r.repo.toLowerCase()))
    const namedOwners = matches.filter((r) => words.has(r.owner.toLowerCase()))
    if (namedOwners.length === 1)
      return {
        repositoryId: namedOwners[0]!.repository_id,
        pr: null,
        reason: "Matched the repository and organization named in your request.",
      }
    if (namedOwners.length > 1) return null
    const preferred = matches.filter(
      (r) => r.owner.toLowerCase() === preferredOrganization.toLowerCase(),
    )
    const candidates = preferred.length > 0 ? preferred : matches
    if (candidates.length === 1)
      return {
        repositoryId: candidates[0]!.repository_id,
        pr: null,
        reason: `Matched ${candidates[0]!.owner}/${candidates[0]!.repo} from your request.`,
      }
    if (candidates.length > 1) return null
  }
  return null
}
