import { assert, describe, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import { MULTICA_SKILL_FILES, MULTICA_SKILL_NAME } from "../../../src/Chat/Sandbox/MulticaSkill.ts"
import { ChatSkills, SkillsGitHub, SkillsGitHubError } from "../../../src/Chat/Sandbox/Skills.ts"

const REPOSITORY = "Effect-TS/janitor-skills"
const SHA = "d".repeat(40)
const MULTICA = { name: MULTICA_SKILL_NAME, files: MULTICA_SKILL_FILES }
const TRIAGE = "---\nname: triage\ndescription: Triage new issues\n---\n"

/** The skills repository: its default branch is at `SHA`, with one skill under `skills`. */
const github = (overrides: Partial<SkillsGitHub["Service"]> = {}) =>
  Layer.succeed(SkillsGitHub, {
    resolveRef: (repository, ref) =>
      repository === REPOSITORY && ref === undefined
        ? Effect.succeed(SHA)
        : Effect.fail(new SkillsGitHubError({ reason: "not found" })),
    readDirectory: (repository, sha, path) =>
      Effect.succeed(
        repository === REPOSITORY && sha === SHA && path === "skills"
          ? [
              { path: "skills/triage/SKILL.md", content: TRIAGE },
              { path: "skills/triage/labels/area.md", content: "area labels" },
            ]
          : [],
      ),
    ...overrides,
  })

/** The skills a sandbox is provisioned with, and the lines logged while reading them. */
const provisioned = (
  config: Record<string, string>,
  client: Layer.Layer<SkillsGitHub> = github(),
) =>
  Effect.gen(function* () {
    const logs: Array<{ readonly level: string; readonly line: string }> = []
    const capture = Logger.make((options) => {
      logs.push({ level: options.logLevel, line: Logger.formatJson.log(options) })
    })
    const skills = yield* Effect.flatMap(ChatSkills, (chat) => chat.load).pipe(
      Effect.provide(
        ChatSkills.layer.pipe(
          Layer.provide(client),
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
        ),
      ),
      Effect.provide(Logger.layer([capture])),
    )
    return { skills, logs }
  })

describe("chat sandbox skills", () => {
  it.effect("without a skills repository, the sandbox gets only multica-platform", () =>
    Effect.gen(function* () {
      const { skills } = yield* provisioned(
        {},
        github({
          resolveRef: () => Effect.die("GitHub was read"),
          readDirectory: () => Effect.die("GitHub was read"),
        }),
      )
      assert.deepStrictEqual(skills, [MULTICA])
    }),
  )

  it.effect("the sandbox gets the repository's skills at the logged SHA", () =>
    Effect.gen(function* () {
      const { skills, logs } = yield* provisioned({ CHAT_SKILLS_REPOSITORY: REPOSITORY })
      assert.deepStrictEqual(skills, [
        MULTICA,
        {
          name: "triage",
          files: [
            { path: "SKILL.md", content: TRIAGE },
            { path: "labels/area.md", content: "area labels" },
          ],
        },
      ])
      assert.isTrue(logs.some(({ line }) => line.includes(REPOSITORY) && line.includes(SHA)))
    }),
  )

  it.effect("a failed read falls back to multica-platform and logs a warning", () =>
    Effect.gen(function* () {
      const { skills, logs } = yield* provisioned(
        { CHAT_SKILLS_REPOSITORY: REPOSITORY },
        github({
          readDirectory: () => Effect.fail(new SkillsGitHubError({ reason: "rate limited" })),
        }),
      )
      assert.deepStrictEqual(skills, [MULTICA])
      assert.isTrue(logs.some(({ level, line }) => level === "Warn" && line.includes(REPOSITORY)))
    }),
  )
})
