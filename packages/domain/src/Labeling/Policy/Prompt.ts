import { isFactName } from "./Condition.ts"
import type { FactName, FactSnapshot, FactValue } from "./Facts.ts"

/**
 * Classifier prompts (plan: "Classifier evaluator"). A prompt names the
 * evidence it wants as `{{fact:title}}`; rendering substitutes the fact's
 * JSON value. Evidence is bounded and untrusted: the system message tells
 * the model never to follow instructions found inside it.
 */

const token = /\{\{fact:([a-zA-Z]+)\}\}/g
export const MAX_RENDERED_LENGTH = 40_000

export type PromptValidation =
  | { readonly _tag: "Valid"; readonly references: ReadonlyArray<FactName> }
  | { readonly _tag: "Invalid"; readonly message: string }

/** Every referenced fact must exist and be among the declared evidence. */
export const validatePrompt = (
  prompt: string,
  evidence: ReadonlyArray<FactName>,
): PromptValidation => {
  const references = new Set<FactName>()
  for (const match of prompt.matchAll(token)) {
    const name = match[1] ?? ""
    if (!isFactName(name)) return { _tag: "Invalid", message: `Unknown fact '${name}' in prompt` }
    if (!evidence.includes(name)) {
      return {
        _tag: "Invalid",
        message: `Fact '${name}' is used in the prompt but not listed as evidence`,
      }
    }
    references.add(name)
  }
  if (prompt.replace(token, "").includes("{{fact:")) {
    return { _tag: "Invalid", message: "Fact references must look like {{fact:title}}" }
  }
  return { _tag: "Valid", references: [...references] }
}

export interface RenderedPrompt {
  readonly text: string
  /** The evidence actually sent, by fact name, for the decision record. */
  readonly evidence: Readonly<Record<string, unknown>>
}

const plain = (value: FactValue): unknown => value.value

/** Substitutes evidence into the prompt; an absent fact renders as null. */
export const renderPrompt = (
  prompt: string,
  evidence: ReadonlyArray<FactName>,
  snapshot: FactSnapshot,
): RenderedPrompt | { readonly _tag: "TooLong"; readonly length: number } => {
  const values: Record<string, unknown> = {}
  for (const name of evidence) {
    const value = snapshot.facts[name]
    values[name] = value === undefined ? null : plain(value)
  }
  const text = prompt.replace(token, (_, name: string) => JSON.stringify(values[name] ?? null))
  return text.length <= MAX_RENDERED_LENGTH
    ? { text, evidence: values }
    : { _tag: "TooLong", length: text.length }
}
