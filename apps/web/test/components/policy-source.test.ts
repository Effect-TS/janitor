import { CompletionContext, type CompletionResult } from "@codemirror/autocomplete"
import { yaml } from "@codemirror/lang-yaml"
import { EditorState } from "@codemirror/state"
import { undo } from "@codemirror/commands"
import * as Result from "effect/Result"
import { describe, expect, it } from "vite-plus/test"
import { formatSource, type FactDescription } from "@/components/labeling-wire"
import {
  createPolicySourceEditor,
  policyCompletionSource,
  formatEditor,
} from "@/components/policy-source/editor"
import { inspect, parse } from "@/components/policy-source/format"

const catalog: ReadonlyArray<FactDescription> = [
  {
    name: "state",
    type: "Text",
    kinds: ["issue", "pull_request"],
    track: "entities",
    description: "Open or closed",
    operators: ["equals", "notEquals"],
    fields: [],
  },
  {
    name: "draft",
    type: "Flag",
    kinds: ["pull_request"],
    track: "pull_requests",
    description: "Draft pull request",
    operators: ["is"],
    fields: [],
  },
  {
    name: "checks",
    type: "Collection",
    kinds: ["pull_request"],
    track: "checks",
    description: "Check runs",
    operators: [],
    fields: [
      { name: "name", type: "Text", operators: ["equals", "contains"] },
      { name: "completed", type: "Flag", operators: ["is"] },
    ],
  },
]
const complete = async (text: string): Promise<CompletionResult | null> => {
  const pos = text.indexOf("|")
  const state = EditorState.create({ doc: text.replace("|", ""), extensions: [yaml()] })
  return policyCompletionSource({
    catalog,
    policyNames: ["ready-for-review", "Ready for review", "true"],
  })(new CompletionContext(state, pos, true))
}

describe("YAML policy source", () => {
  it("round trips stored policies and accepts existing JSON", () => {
    const source = {
      target: "pull_request" as const,
      matchesWhen: {
        all: [{ policy: "ready-for-review" }, { fact: "draft", operator: "is", value: false }],
      },
    }
    const formatted = formatSource(source)
    expect(formatted).toContain("- policy: ready-for-review")
    expect(formatted).not.toContain('"target"')
    expect(Result.getOrThrow(parse(formatted))).toEqual(source)
    expect(Result.getOrThrow(parse(JSON.stringify(source)))).toEqual(source)
  })

  it("keeps multiline prompts and quoted scalar types", () => {
    const result = parse(
      "target: issue\nclassify:\n  prompt: |\n    Is this a bug?\n    Ignore feature requests.\n  evidence: [title]\n  minimumConfidence: 0.8\n",
    )
    expect(Result.getOrThrow(result)).toEqual({
      target: "issue",
      classify: {
        prompt: "Is this a bug?\nIgnore feature requests.\n",
        evidence: ["title"],
        minimumConfidence: 0.8,
      },
    })
    expect(Result.getOrThrow(parse('target: issue\nmatchesWhen:\n  policy: "true"\n'))).toEqual({
      target: "issue",
      matchesWhen: { policy: "true" },
    })
  })

  it.each([
    "",
    "[]",
    "target: issue\ntarget: pull_request",
    "target: [",
    "target: issue\n---\ntarget: issue",
    "target: !custom issue",
    "target: issue\nvalue: .nan",
    "target: issue\nvalue: .inf",
    "target: issue\nx: &x { recursive: *x }",
    "target: issue\nx: &x 1\ny: *x",
  ])("rejects ambiguous or non-JSON-compatible YAML: %s", (source) => {
    expect(Result.isFailure(parse(source))).toBe(true)
  })
})

describe("YAML policy completion", () => {
  it("offers root keys at the document start and condition keys under a matcher", async () => {
    expect((await complete("|"))?.options.map((x) => x.label)).toEqual([
      "target",
      "appliesWhen",
      "matchesWhen",
      "classify",
    ])
    expect(
      (await complete("target: pull_request\nmatchesWhen:\n  |"))?.options.map((x) => x.label),
    ).toContain("policy")
    expect(
      (await complete("target: pull_request\nmatchesWhen:\n  fa|"))?.options.find(
        (x) => x.label === "fact",
      )?.apply,
    ).toBe("fact: ")
  })

  it("replaces complete policy names without doubled quotes or lost hyphens", async () => {
    for (const source of [
      "matchesWhen:\n  policy: ready-for-|review",
      'matchesWhen:\n  policy: "Ready for |review"',
      "matchesWhen:\n  policy: |",
    ]) {
      const result = await complete(source)
      expect(result?.options.map((x) => x.label)).toContain("ready-for-review")
      const choice = result!.options.find((x) => x.label === "ready-for-review")!
      const doc = source.replace("|", "")
      const applied =
        doc.slice(0, result!.from) + choice.apply + doc.slice(result!.to ?? source.indexOf("|"))
      expect(Result.getOrThrow(parse(applied))).toEqual({
        matchesWhen: { policy: "ready-for-review" },
      })
      expect(result!.options.find((x) => x.label === "true")?.apply).toBe('"true"')
    }
  })

  it("uses the selected target, predicate type, and collection item fields", async () => {
    expect(
      (await complete("target: issue\nmatchesWhen:\n  fact: |"))?.options.map((x) => x.label),
    ).toEqual(["state"])
    expect(
      (
        await complete("target: pull_request\nmatchesWhen:\n  fact: draft\n  operator: |")
      )?.options.map((x) => x.label),
    ).toEqual(["is"])
    expect(
      (await complete("matchesWhen:\n  some: checks\n  where:\n    fact: |"))?.options.map(
        (x) => x.label,
      ),
    ).toEqual(["name", "completed"])
    expect(
      (
        await complete("matchesWhen:\n  some: checks\n  where:\n    fact: completed\n    value: |")
      )?.options.map((x) => x.label),
    ).toEqual(["true", "false"])
  })

  it("offers evidence facts but stays out of comments and multiline prompts", async () => {
    expect(
      (await complete("classify:\n  evidence:\n    - |"))?.options.map((x) => x.label),
    ).toContain("state")
    expect(await complete("# comment |")).toBeNull()
    expect(await complete("classify:\n  prompt: >\n    some text |")).toBeNull()
  })
})

describe("YAML editor integration", () => {
  it("reports the offending YAML location", () => {
    const source = "target: issue\ntarget: pull_request\n"
    const result = inspect(source)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure.from).toBe(source.indexOf("target", 1))
      expect(result.failure.message).toContain("Map keys must be unique")
    }
  })

  it("formats YAML while retaining comments and one-step undo", () => {
    const element = document.createElement("div")
    element.id = "format-test-editor"
    document.body.append(element)
    const source =
      "# Keep this explanation\ntarget: issue\nmatchesWhen:\n    policy: Ready # Keep this too\n"
    const changes: string[] = []
    const editor = createPolicySourceEditor({
      element,
      initialSource: source,
      context: { catalog, policyNames: ["Ready"] },
      onChange: (value) => changes.push(value),
    })
    try {
      const formatted = formatEditor(element.id)
      expect(formatted).toContain("# Keep this explanation")
      expect(formatted).toContain("  policy: Ready # Keep this too")
      expect(Result.getOrThrow(parse(formatted))).toEqual(Result.getOrThrow(parse(source)))
      expect(changes).toEqual([formatted])
      expect(undo(editor)).toBe(true)
      expect(editor.state.doc.toString()).toBe(source)
    } finally {
      editor.destroy()
      element.remove()
    }
  })

  it("mounts with an accessible YAML label and sends source edits back", () => {
    const element = document.createElement("div")
    document.body.append(element)
    const changes: Array<string> = []
    const editor = createPolicySourceEditor({
      element,
      initialSource: "target: issue\n",
      context: { catalog, policyNames: ["ready-for-review"] },
      onChange: (source) => changes.push(source),
    })
    try {
      expect(editor.contentDOM.getAttribute("aria-label")).toBe("Policy program YAML")
      editor.dispatch({
        changes: {
          from: editor.state.doc.length,
          insert: "matchesWhen:\n  policy: ready-for-review\n",
        },
      })
      expect(changes).toEqual(["target: issue\nmatchesWhen:\n  policy: ready-for-review\n"])
      expect(Result.getOrThrow(parse(changes[0]!))).toEqual({
        target: "issue",
        matchesWhen: { policy: "ready-for-review" },
      })
    } finally {
      editor.destroy()
      element.remove()
    }
  })
})
