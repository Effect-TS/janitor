import { describe, expect, it } from "vite-plus/test"
import * as Option from "effect/Option"
import { parseInvocation } from "@janitor/domain/PullRequestReview/Invocation"

const direct = (body: string) => Option.isSome(parseInvocation(body))
const guidance = (body: string) => Option.getOrThrow(parseInvocation(body)).guidance

describe("Review invocation", () => {
  it("accepts the slash command anywhere in a free-form request", () => {
    expect(direct("/janitor")).toBe(true)
    expect(direct("/janitor\nPlease investigate.")).toBe(true)
    expect(direct("/janitor please look at this")).toBe(true)
    expect(direct("Could you check whether this still happens, /janitor?")).toBe(true)
    expect(direct("cc /Janitor\nI think it's the scheduler.")).toBe(true)
    expect(direct("(/janitor)")).toBe(true)
  })

  it("ignores user mentions, other commands, URLs and paths", () => {
    expect(direct("please review")).toBe(false)
    expect(direct("@effect-janitor please look at this")).toBe(false)
    expect(direct("@janitor please look at this")).toBe(false)
    expect(direct("@Janitor please look at this")).toBe(false)
    expect(direct("/janitor-bot look")).toBe(false)
    expect(direct("/janitorial")).toBe(false)
    expect(direct("mail/janitor")).toBe(false)
    expect(direct("janitor without the slash")).toBe(false)
    expect(direct("https://example.com/janitor")).toBe(false)
    expect(direct("/janitor/tests")).toBe(false)
    expect(direct("/janitor.md")).toBe(false)
    expect(direct("/janitor_extra")).toBe(false)
    expect(direct("//janitor")).toBe(false)
  })

  it("ignores commands inside quoted text", () => {
    expect(direct("> /janitor please look\n\nI disagree with the above.")).toBe(false)
    expect(direct(">/janitor\n> continued quote")).toBe(false)
    expect(direct("> quoted\n\n/janitor now for real")).toBe(true)
  })

  it("ignores commands inside code spans and fenced blocks", () => {
    expect(direct("run `/janitor` to see")).toBe(false)
    expect(direct("```\n/janitor\n```")).toBe(false)
    expect(direct("~~~md\n/janitor\n~~~")).toBe(false)
    expect(direct("```ts\nconst x = 1\n```\n/janitor after the fence")).toBe(true)
    expect(direct("`code` then /janitor")).toBe(true)
    // A closing fence may be longer than its opener; the text after it is prose.
    expect(direct("```\n/janitor\n````\nplain")).toBe(false)
    expect(direct("```\ncode\n````\n/janitor after")).toBe(true)
    expect(direct("Output:\n\n    /janitor indented code")).toBe(false)
    expect(direct("<pre>/janitor</pre>")).toBe(false)
    expect(direct("<code>/janitor</code> and nothing else")).toBe(false)
    expect(direct("<code>x</code> and /janitor outside")).toBe(true)
  })

  it("ignores commands inside link destinations and HTML comments", () => {
    expect(direct("[see this](https://github.com/janitor)")).toBe(false)
    expect(direct("<https://example.com/janitor>")).toBe(false)
    expect(direct("<!-- /janitor -->")).toBe(false)
    expect(direct("[/janitor](https://example.com)")).toBe(true)
  })

  it("returns the invoker text after the direct command", () => {
    expect(guidance("/janitor")).toBe("")
    expect(guidance("/janitor  focus on the cache invalidation  ")).toBe(
      "focus on the cache invalidation",
    )
    expect(guidance("Thanks!\n/janitor\nCheck the migration.\nIgnore the docs.")).toBe(
      "Check the migration.\nIgnore the docs.",
    )
    // A quoted or code command is evidence; the text after the direct one counts.
    expect(guidance("> /janitor old ask\n\nrun `/janitor` again? /janitor only the tests")).toBe(
      "only the tests",
    )
    // Code after the command belongs to the invoker text.
    expect(guidance("/janitor is this safe?\n```ts\nrace()\n```")).toBe(
      "is this safe?\n```ts\nrace()\n```",
    )
  })
})
