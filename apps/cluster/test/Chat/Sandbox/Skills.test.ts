import { assert, describe, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import { MULTICA_SKILL_FILES, MULTICA_SKILL_NAME } from "../../../src/Chat/Sandbox/MulticaSkill.ts"
import {
  ChatSkills,
  MAX_SKILLS_BYTES,
  type RepositoryFile,
  SkillsGitHub,
  SkillsReadError,
} from "../../../src/Chat/Sandbox/Skills.ts"

const REPOSITORY = "Effect-TS/janitor-skills"
const SHA = "d".repeat(40)
const MULTICA = { name: MULTICA_SKILL_NAME, files: MULTICA_SKILL_FILES }
const TRIAGE = "---\nname: triage\ndescription: Triage new issues\n---\n"
const TRIAGE_FILES: ReadonlyArray<RepositoryFile> = [
  { path: ".agents/skills/triage/SKILL.md", content: TRIAGE },
  { path: ".agents/skills/triage/labels/area.md", content: "area labels" },
]
const TRIAGE_SKILL = {
  name: "triage",
  files: [
    { path: "SKILL.md", content: TRIAGE },
    { path: "labels/area.md", content: "area labels" },
  ],
}

/** The skills repository: its default branch is at `SHA`, with `files` at that commit. */
const github = (
  files: ReadonlyArray<RepositoryFile> = TRIAGE_FILES,
  overrides: Partial<SkillsGitHub["Service"]> = {},
) =>
  Layer.succeed(SkillsGitHub, {
    resolveRef: (repository, ref) =>
      repository === REPOSITORY && ref === undefined
        ? Effect.succeed(SHA)
        : Effect.fail(new SkillsReadError({ reason: "not found" })),
    readDirectory: (repository, sha, path) =>
      Effect.succeed(
        repository === REPOSITORY && sha === SHA && path === ".agents/skills" ? files : [],
      ),
    ...overrides,
  })

/** The skills the last of `loads` sandboxes is provisioned with, and the lines logged meanwhile. */
const provisioned = (
  config: Record<string, string>,
  client: Layer.Layer<SkillsGitHub> = github(),
  loads = 1,
) =>
  Effect.gen(function* () {
    const logs: Array<{ readonly level: string; readonly line: string }> = []
    const capture = Logger.make((options) => {
      logs.push({ level: options.logLevel, line: Logger.formatJson.log(options) })
    })
    const skills = yield* Effect.flatMap(ChatSkills, (chat) =>
      Effect.replicateEffect(chat.load, loads),
    ).pipe(
      Effect.map((loaded) => loaded.at(-1)!),
      Effect.provide(
        Layer.mergeAll(
          ChatSkills.layer.pipe(
            Layer.provide(client),
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
          ),
          Logger.layer([capture]),
        ),
      ),
    )
    const warned = (text: string) =>
      logs.some(({ level, line }) => level === "Warn" && line.includes(text))
    return { skills, logs, warned }
  })

const configured = { CHAT_SKILLS_REPOSITORY: REPOSITORY }

describe("chat sandbox skills", () => {
  it.effect("without a skills repository, the sandbox gets only multica-platform", () =>
    Effect.gen(function* () {
      const { skills } = yield* provisioned(
        {},
        github([], {
          resolveRef: () => Effect.die("GitHub was read"),
          readDirectory: () => Effect.die("GitHub was read"),
        }),
      )
      assert.deepStrictEqual(skills, [MULTICA])
    }),
  )

  it.effect("the sandbox gets the repository's skills at the logged SHA", () =>
    Effect.gen(function* () {
      const { skills, logs } = yield* provisioned(configured)
      assert.deepStrictEqual(skills, [MULTICA, TRIAGE_SKILL])
      assert.isTrue(logs.some(({ line }) => line.includes(REPOSITORY) && line.includes(SHA)))
    }),
  )

  it.effect("a failed read falls back to multica-platform and logs a warning", () =>
    Effect.gen(function* () {
      const { skills, warned } = yield* provisioned(
        configured,
        github(TRIAGE_FILES, {
          readDirectory: () => Effect.fail(new SkillsReadError({ reason: "rate limited" })),
        }),
      )
      assert.deepStrictEqual(skills, [MULTICA])
      assert.isTrue(warned(REPOSITORY))
    }),
  )

  it.effect("skills over the size cap fall back to multica-platform", () =>
    Effect.gen(function* () {
      const { skills, warned } = yield* provisioned(
        configured,
        github([
          ...TRIAGE_FILES,
          { path: ".agents/skills/triage/big.md", content: "x".repeat(MAX_SKILLS_BYTES) },
        ]),
      )
      assert.deepStrictEqual(skills, [MULTICA])
      assert.isTrue(warned(REPOSITORY))
    }),
  )

  it.effect("folders that aren't usable skills are skipped with a warning", () =>
    Effect.gen(function* () {
      const { skills, warned } = yield* provisioned(
        configured,
        github([
          ...TRIAGE_FILES,
          { path: ".agents/skills/README.md", content: "the skills" },
          { path: ".agents/skills/multica-platform/SKILL.md", content: "an older CLI" },
          { path: ".agents/skills/Bad_Name/SKILL.md", content: "bad name" },
          { path: ".agents/skills/notes/README.md", content: "no SKILL.md" },
        ]),
      )
      assert.deepStrictEqual(skills, [MULTICA, TRIAGE_SKILL])
      assert.isTrue(warned("multica-platform"))
      assert.isTrue(warned("Bad_Name"))
      assert.isTrue(warned("notes"))
    }),
  )

  it.effect("a commit's skills are read from GitHub once", () =>
    Effect.gen(function* () {
      let reads = 0
      const { skills } = yield* provisioned(
        configured,
        github(TRIAGE_FILES, {
          readDirectory: () => Effect.sync(() => (reads++, TRIAGE_FILES)),
        }),
        2,
      )
      assert.deepStrictEqual(skills, [MULTICA, TRIAGE_SKILL])
      assert.strictEqual(reads, 1)
    }),
  )
})
