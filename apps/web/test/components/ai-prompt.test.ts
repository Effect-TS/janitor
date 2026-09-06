import { describe, it, expect } from "vite-plus/test"
import { inspectAiPrompt } from "@janitor/domain/Labeling/Policy/PromptReferences"
import { EditorState } from "@codemirror/state"
import { CompletionContext } from "@codemirror/autocomplete"
import { aiCompletion } from "../../src/components/policy-source/ai-editor"
const catalog = [
  {
    name: "title",
    kinds: ["issue", "pull_request"] as const,
    type: "Text" as const,
    description: "Title",
    track: "entities",
    fields: [],
    operators: [],
  },
  {
    name: "changedFiles",
    kinds: ["pull_request"] as const,
    type: "Collection" as const,
    description: "Changed paths",
    track: "changed_files",
    fields: [],
    operators: [],
  },
]
describe("AI prompt references", () => {
  it("derives unique facts and rejects unsupported or incomplete references", () => {
    expect(inspectAiPrompt("{{fact:title}} {{fact:title}}", "issue", catalog).references).toEqual([
      "title",
    ])
    for (const prompt of [
      "{{fact:diff}}",
      "{{fact:title",
      "{{fact:changedFiles}}",
      "No references",
    ])
      expect(inspectAiPrompt(prompt, "issue", catalog).diagnostics.length).toBeGreaterThan(0)
  })
  it("offers target-compatible tokens directly inside instructions", () => {
    const doc = "Question: {{"
    const result = aiCompletion(
      catalog,
      "issue",
    )(new CompletionContext(EditorState.create({ doc }), doc.length, false))
    expect(result?.from).toBe(10)
    expect(result?.options.map((o) => o.label)).toEqual(["{{fact:title}}"])
  })
})
