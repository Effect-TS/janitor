import { GITHUB_API_BASE_URL, GITHUB_REQUEST_HEADERS } from "@janitor/domain/GitHub/Api"
import { GitHubInstallationId } from "@janitor/domain/GitHub/Id"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { GitHubAppAuth } from "../../GitHub/AppAuth.ts"
import { chatSkillsConfig, type ChatSkillsSettings } from "../Config.ts"
import { MULTICA_SKILL_FILES, MULTICA_SKILL_NAME } from "./MulticaSkill.ts"
import { Skill } from "./Provision.ts"

/**
 * The chat bot's skills (EFF-3085): the bundled `multica-platform`, plus the
 * skills in a GitHub repository named in config, read through janitor's App.
 * Each sandbox is provisioned with the skills at the commit the configured
 * ref points to when it is acquired, so a deployment changes its bot's
 * skills by merging to that repository, without redeploying janitor.
 *
 * `multica-platform` describes the CLI baked into the image, so it is always
 * there and a repository skill of the same name is dropped. A repository that
 * can't be read never stops a turn: the sandbox gets `multica-platform` only.
 */

/** The most file content a repository's skills may hold, in bytes. */
export const MAX_SKILLS_BYTES = 1024 * 1024

/** The most files a repository's skills may hold. */
export const MAX_SKILLS_FILES = 200

/** The skills repository couldn't be read, or its skills are over the caps. */
export class SkillsReadError extends Schema.TaggedError<SkillsReadError>()("SkillsReadError", {
  reason: Schema.String,
}) {}

/** A file in the skills repository, its path from the repository's root. */
export interface RepositoryFile {
  readonly path: string
  readonly content: string
}

/** The reads skills take from GitHub. `repository` is `owner/name`. */
export class SkillsGitHub extends Context.Service<
  SkillsGitHub,
  {
    /** The commit `ref` points to, or the default branch's when `ref` is undefined. */
    readonly resolveRef: (
      repository: string,
      ref: string | undefined,
    ) => Effect.Effect<string, SkillsReadError>
    /** Every file under `path` at commit `sha`, recursively. Fails past the caps. */
    readonly readDirectory: (
      repository: string,
      sha: string,
      path: string,
    ) => Effect.Effect<ReadonlyArray<RepositoryFile>, SkillsReadError>
  }
>()("@janitor/cluster/Chat/Sandbox/Skills/SkillsGitHub") {
  /** Reads through janitor's App, installed on the skills repository. */
  static readonly layer: Layer.Layer<SkillsGitHub, never, GitHubAppAuth | HttpClient.HttpClient> =
    Layer.effect(
      SkillsGitHub,
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient
        const auth = yield* GitHubAppAuth
        /** Installation ids by lowercased repository. */
        const installations = new Map<string, GitHubInstallationId>()

        const send = <A, E>(
          what: string,
          url: string,
          token: Redacted.Redacted<string>,
          accept: string,
          read: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E>,
        ) =>
          Effect.gen(function* () {
            const response = yield* http
              .execute(
                HttpClientRequest.get(`${GITHUB_API_BASE_URL}${url}`).pipe(
                  HttpClientRequest.bearerToken(Redacted.value(token)),
                  HttpClientRequest.setHeaders({ ...GITHUB_REQUEST_HEADERS, accept }),
                ),
              )
              .pipe(Effect.mapError(() => new SkillsReadError({ reason: `${what} failed` })))
            if (response.status !== 200) {
              return yield* new SkillsReadError({
                reason: `${what} answered ${response.status}`,
              })
            }
            return yield* read(response).pipe(
              Effect.mapError(() => new SkillsReadError({ reason: `${what} was unreadable` })),
            )
          })

        const token = (repository: string) =>
          Effect.gen(function* () {
            const key = repository.toLowerCase()
            let id = installations.get(key)
            if (id === undefined) {
              const jwt = yield* auth.appJwt.pipe(
                Effect.mapError(
                  () => new SkillsReadError({ reason: "signing the App JWT failed" }),
                ),
              )
              const installation = yield* send(
                "the installation lookup",
                `/repos/${repository}/installation`,
                jwt,
                GITHUB_REQUEST_HEADERS.accept,
                decodeInstallation,
              )
              id = GitHubInstallationId.make(String(installation.id))
              installations.set(key, id)
            }
            // A failed token may mean the App was reinstalled under a new id: look it up again.
            return yield* auth.installationToken(id).pipe(
              Effect.mapError(
                () => new SkillsReadError({ reason: "the installation token request failed" }),
              ),
              Effect.tapError(() => Effect.sync(() => installations.delete(key))),
            )
          })

        const resolveRef = (repository: string, ref: string | undefined) =>
          Effect.gen(function* () {
            const credential = yield* token(repository)
            const name =
              ref ??
              (yield* send(
                "the repository lookup",
                `/repos/${repository}`,
                credential,
                GITHUB_REQUEST_HEADERS.accept,
                decodeRepository,
              )).default_branch
            const sha = yield* send(
              "resolving the ref",
              `/repos/${repository}/commits/${encodeURIComponent(name)}`,
              credential,
              "application/vnd.github.sha",
              (response) => response.text,
            )
            const trimmed = sha.trim()
            if (!/^[0-9a-f]{40}$/.test(trimmed)) {
              return yield* new SkillsReadError({ reason: "resolving the ref gave no commit" })
            }
            return trimmed
          })

        const readDirectory = (repository: string, sha: string, path: string) =>
          Effect.gen(function* () {
            const credential = yield* token(repository)
            const { tree, truncated } = yield* send(
              "listing the tree",
              `/repos/${repository}/git/trees/${sha}?recursive=1`,
              credential,
              GITHUB_REQUEST_HEADERS.accept,
              decodeTree,
            )
            if (truncated) {
              return yield* new SkillsReadError({ reason: "the repository is too large to list" })
            }
            const prefix = path === "" ? "" : `${path}/`
            // Symlinks are blobs too; their content is a path, not a file.
            const blobs = tree.filter(
              (entry) =>
                entry.type === "blob" && entry.mode !== "120000" && entry.path.startsWith(prefix),
            )
            const bytes = blobs.reduce((total, entry) => total + (entry.size ?? 0), 0)
            if (blobs.length > MAX_SKILLS_FILES || bytes > MAX_SKILLS_BYTES) {
              return yield* tooLarge
            }
            return yield* Effect.forEach(
              blobs,
              (entry) =>
                send(
                  "reading a file",
                  `/repos/${repository}/git/blobs/${entry.sha}`,
                  credential,
                  "application/vnd.github.raw+json",
                  (response) => response.text,
                ).pipe(Effect.map((content) => ({ path: entry.path, content }))),
              { concurrency: 8 },
            )
          })

        return { resolveRef, readDirectory }
      }),
    )
}

const TreeApi = Schema.Struct({
  tree: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      mode: Schema.String,
      type: Schema.String,
      sha: Schema.String,
      size: Schema.optional(Schema.Int),
    }),
  ),
  truncated: Schema.Boolean,
})

const decodeInstallation = HttpClientResponse.schemaBodyJson(Schema.Struct({ id: Schema.Int }))
const decodeRepository = HttpClientResponse.schemaBodyJson(
  Schema.Struct({ default_branch: Schema.String }),
)
const decodeTree = HttpClientResponse.schemaBodyJson(TreeApi)

const tooLarge = new SkillsReadError({
  reason: `the skills are over ${MAX_SKILLS_FILES} files or ${MAX_SKILLS_BYTES} bytes`,
})

/** The skill bundled with janitor, pinned to the sandbox image's CLI. */
export const MULTICA_SKILL: Skill = { name: MULTICA_SKILL_NAME, files: MULTICA_SKILL_FILES }

const decodeSkill = Schema.decodeUnknownOption(Skill)

const encoder = new TextEncoder()

/**
 * The skills in `files`, one per folder directly under `directory` that holds
 * a `SKILL.md`. A folder that isn't a valid skill, or is named after
 * `multica-platform`, is skipped with a warning; files directly in
 * `directory` are not skills and are left out.
 */
const collectSkills = (directory: string, files: ReadonlyArray<RepositoryFile>) =>
  Effect.gen(function* () {
    const bytes = files.reduce((total, file) => total + encoder.encode(file.content).length, 0)
    if (files.length > MAX_SKILLS_FILES || bytes > MAX_SKILLS_BYTES) return yield* tooLarge
    const prefix = directory === "" ? "" : `${directory}/`
    const folders = new Map<string, Array<{ path: string; content: string }>>()
    for (const file of files) {
      if (!file.path.startsWith(prefix)) continue
      const relative = file.path.slice(prefix.length)
      const slash = relative.indexOf("/")
      if (slash === -1) continue
      const name = relative.slice(0, slash)
      const folder = folders.get(name) ?? []
      folder.push({ path: relative.slice(slash + 1), content: file.content })
      folders.set(name, folder)
    }
    const skills: Array<Skill> = []
    for (const [name, folder] of folders) {
      const skipped = (reason: string) =>
        Effect.logWarning(`Skipped the chat skill ${name}: ${reason}`)
      if (name === MULTICA_SKILL_NAME) {
        yield* skipped("the bundled multica-platform skill takes its name")
        continue
      }
      if (!folder.some((file) => file.path === "SKILL.md")) {
        yield* skipped("it has no SKILL.md")
        continue
      }
      const skill = decodeSkill({ name, files: folder })
      if (Option.isNone(skill)) {
        yield* skipped("its name or a file path is invalid")
        continue
      }
      skills.push(skill.value)
    }
    return skills
  })

export class ChatSkills extends Context.Service<
  ChatSkills,
  {
    /** The skills to provision a sandbox with, `multica-platform` first. Never fails. */
    readonly load: Effect.Effect<ReadonlyArray<Skill>>
  }
>()("@janitor/cluster/Chat/Sandbox/Skills/ChatSkills") {
  /** No skills repository: every sandbox gets `multica-platform` only. */
  static readonly bundled: Layer.Layer<ChatSkills> = Layer.succeed(ChatSkills, {
    load: Effect.succeed([MULTICA_SKILL]),
  })

  static readonly layerFrom = (
    settings: ChatSkillsSettings,
  ): Layer.Layer<ChatSkills, never, SkillsGitHub> =>
    Layer.effect(
      ChatSkills,
      Effect.gen(function* () {
        if (Option.isNone(settings.repository)) return { load: Effect.succeed([MULTICA_SKILL]) }
        const repository = settings.repository.value
        const ref = Option.getOrUndefined(settings.ref)
        const github = yield* SkillsGitHub
        /** The skills at the last commit read; a new commit replaces them. */
        let cached: { readonly sha: string; readonly skills: ReadonlyArray<Skill> } | undefined

        const load = Effect.gen(function* () {
          const sha = yield* github.resolveRef(repository, ref)
          if (cached?.sha !== sha) {
            const files = yield* github.readDirectory(repository, sha, settings.directory)
            cached = { sha, skills: yield* collectSkills(settings.directory, files) }
          }
          const skills = cached.skills
          yield* Effect.logInfo("Provisioning the chat sandbox with the repository's skills").pipe(
            Effect.annotateLogs({
              repository,
              sha,
              skills: skills.map((skill) => skill.name).join(","),
            }),
          )
          return [MULTICA_SKILL, ...skills]
        }).pipe(
          Effect.catch((error) =>
            Effect.as(
              Effect.logWarning(
                "The chat skills repository couldn't be read; provisioning multica-platform only",
                error.reason,
              ).pipe(Effect.annotateLogs({ repository })),
              [MULTICA_SKILL],
            ),
          ),
        )
        return { load }
      }),
    )

  /** Reads `CHAT_SKILLS_*` itself. A bad setting is a deployment defect. */
  static readonly layer: Layer.Layer<ChatSkills, never, SkillsGitHub> = Layer.unwrap(
    Effect.map(Effect.orDie(chatSkillsConfig), ChatSkills.layerFrom),
  )
}
