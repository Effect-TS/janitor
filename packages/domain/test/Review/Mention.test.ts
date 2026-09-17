import { describe, expect, it } from "vite-plus/test"
import { REVIEW_MENTION_HANDLE, mentionsDirectly } from "@janitor/domain/Review/Mention"

const direct = (body: string) => mentionsDirectly(body, REVIEW_MENTION_HANDLE)

describe("Review mention", () => {
  it("accepts a free-form request that mentions Janitor anywhere in plain text", () => {
    expect(direct("@effect-janitor please look at this")).toBe(true)
    expect(direct("Could you check whether this still happens, @effect-janitor?")).toBe(true)
    expect(direct("cc @Effect-Janitor\nI think it's the scheduler.")).toBe(true)
    expect(direct("(@effect-janitor)")).toBe(true)
  })

  it("ignores comments without the mention or with a different handle", () => {
    expect(direct("please review")).toBe(false)
    expect(direct("@effect-janitor-bot look")).toBe(false)
    expect(direct("@effect-janitorial")).toBe(false)
    expect(direct("mail@effect-janitor")).toBe(false)
    expect(direct("effect-janitor without the at sign")).toBe(false)
  })

  it("ignores mentions inside quoted text", () => {
    expect(direct("> @effect-janitor please look\n\nI disagree with the above.")).toBe(false)
    expect(direct(">@effect-janitor\n> continued quote")).toBe(false)
    expect(direct("> quoted\n\n@effect-janitor now for real")).toBe(true)
  })

  it("ignores mentions inside code spans and fenced blocks", () => {
    expect(direct("run `@effect-janitor` to see")).toBe(false)
    expect(direct("```\n@effect-janitor\n```")).toBe(false)
    expect(direct("~~~md\n@effect-janitor\n~~~")).toBe(false)
    expect(direct("```ts\nconst x = 1\n```\n@effect-janitor after the fence")).toBe(true)
    expect(direct("`code` then @effect-janitor")).toBe(true)
  })

  it("ignores mentions inside link destinations and HTML comments", () => {
    expect(direct("[see this](https://github.com/@effect-janitor)")).toBe(false)
    expect(direct("<https://example.com/@effect-janitor>")).toBe(false)
    expect(direct("<!-- @effect-janitor -->")).toBe(false)
    expect(direct("[@effect-janitor](https://example.com)")).toBe(true)
  })
})
