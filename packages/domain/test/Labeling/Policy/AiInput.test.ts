import { describe, expect, it } from "vite-plus/test"
import {
  prepareClassifierInput,
  inputBytes,
  DEFAULT_INPUT_BYTES,
} from "@janitor/domain/Labeling/Policy/AiInput"
import { snapshotFacts } from "@janitor/domain/Labeling/Policy/Facts"
const snapshot = (body: string) =>
  snapshotFacts({
    kind: "pull_request",
    title: "A short title",
    body,
    authorLogin: "author",
    state: "open",
    labels: [],
    pullRequest: { baseRef: "main", draft: false, headSha: "a".repeat(40) },
  })
describe("AI input preparation", () => {
  it("keeps a 10.5 KB body plus 1.7 KB instructions without loss", () => {
    const source = snapshot("Paragraph. ".repeat(950))
    const result = prepareClassifierInput(
      "Instructions. ".repeat(120) + "{{fact:title}} {{fact:body}}",
      ["title", "body"],
      source,
    )
    expect(result._tag).toBe("Prepared")
    if (result._tag !== "Prepared") return
    expect(result.report.status).toBe("complete")
    expect(inputBytes(result.text)).toBeLessThanOrEqual(DEFAULT_INPUT_BYTES)
  })
  it("sends each referenced fact once and excludes unused evidence", () => {
    const result = prepareClassifierInput(
      "{{fact:title}} and {{fact:title}}",
      ["title", "body"],
      snapshot("body not requested"),
    )
    expect(result._tag).toBe("Prepared")
    if (result._tag !== "Prepared") return
    expect(result.report.facts.map((f) => f.name)).toEqual(["title"])
    expect(JSON.parse(result.text).evidence).toEqual({ title: "A short title" })
  })
  it("bounds Unicode input, preserves instructions and exposes exact omitted text", () => {
    const body = "First paragraph.\n" + "🔥中文 evidence\n".repeat(3000) + "Last paragraph."
    const instructions = "Classify {{fact:title}} using {{fact:body}}."
    const result = prepareClassifierInput(instructions, ["title", "body"], snapshot(body), 4000)
    expect(result._tag).toBe("Prepared")
    if (result._tag !== "Prepared") return
    expect(result.report.status).toBe("shortened")
    expect(inputBytes(result.text)).toBeLessThanOrEqual(4000)
    expect(result.report.facts[0]?.omission).toBeNull()
    const fact = result.report.facts.find((f) => f.name === "body")!
    const sent = JSON.parse(result.text)
    expect(sent.instructions).toBe(instructions)
    expect(sent.evidence.body).toContain("First paragraph.")
    expect(sent.evidence.body).toContain("Last paragraph.")
    expect(JSON.parse(result.details.facts.find((f) => f.name === "body")!.json)).toBe(body)
    expect(fact.omission!.end).toBeGreaterThan(fact.omission!.start)
    expect(sent.evidence.body).not.toContain("\ufffd")
    expect(prepareClassifierInput(instructions, ["title", "body"], snapshot(body), 4000)).toEqual(
      result,
    )
  })
  it("drops complete collection entries and does not shorten small facts", () => {
    const source = snapshotFacts({
      kind: "pull_request",
      title: "Title",
      body: null,
      authorLogin: "author",
      state: "open",
      labels: [],
      pullRequest: { baseRef: "main", draft: false, headSha: "a".repeat(40) },
      collections: {
        files: Array.from({ length: 300 }, (_, i) => ({
          path: `src/${i}/` + "long".repeat(15),
          status: "modified",
        })),
        checks: [],
        reviews: [],
      },
    })
    const result = prepareClassifierInput(
      "{{fact:title}} {{fact:changedFiles}}",
      ["title", "changedFiles"],
      source,
      4000,
    )
    expect(result._tag).toBe("Prepared")
    if (result._tag !== "Prepared") return
    expect(result.report.facts[1]?.omission?.unit).toBe("items")
    expect(Array.isArray(JSON.parse(result.text).evidence.changedFiles)).toBe(true)
    expect(inputBytes(result.text)).toBeLessThanOrEqual(4000)
  })
  it("rejects oversized instructions or uninspectable sources before provider work", () => {
    expect(prepareClassifierInput("x".repeat(5000), [], snapshot(""), 4000)._tag).toBe("Rejected")
    const result = prepareClassifierInput("{{fact:body}}", ["body"], snapshot("x".repeat(130000)))
    expect(result._tag).toBe("Rejected")
    if (result._tag === "Rejected") expect(result.reason).toContain("inspection limit")
  })
})
