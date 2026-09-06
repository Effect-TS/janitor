/** Pure prompt parsing shared by the browser and API; no runtime dependencies. */
export interface PromptFact {
  readonly name: string
  readonly kinds: ReadonlyArray<string>
}
export interface PromptDiagnostic {
  readonly from: number
  readonly to: number
  readonly message: string
}
export const inspectAiPrompt = (
  prompt: string,
  target: string,
  catalog: ReadonlyArray<PromptFact>,
) => {
  const references = new Set<string>()
  const diagnostics: Array<PromptDiagnostic> = []
  if (!prompt.trim() || prompt.length > 4000)
    diagnostics.push({
      from: 0,
      to: prompt.length,
      message: "Instructions must contain 1–4,000 characters",
    })
  const token = /\{\{[^}]*\}\}|\{\{[^\n]*/g
  for (const match of prompt.matchAll(token)) {
    const from = match.index
    const name = /^\{\{fact:([a-zA-Z]+)\}\}$/.exec(match[0])?.[1]
    const fact = catalog.find((item) => item.name === name)
    const message = !name
      ? "Use {{fact:name}} for a fact reference"
      : !fact
        ? `Unknown fact '${name}'`
        : !fact.kinds.includes(target)
          ? `Fact '${name}' is unavailable for ${target === "issue" ? "issues" : "pull requests"}`
          : null
    if (message) diagnostics.push({ from, to: from + match[0].length, message })
    else if (name) references.add(name)
  }
  if (!references.size && !diagnostics.length)
    diagnostics.push({
      from: 0,
      to: prompt.length,
      message: "Reference at least one fact using {{fact:...}}",
    })
  if (references.size > 8)
    diagnostics.push({ from: 0, to: prompt.length, message: "Use at most eight different facts" })
  return { references: [...references].sort(), diagnostics }
}
