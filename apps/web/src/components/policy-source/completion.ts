import {
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionSource,
} from "@codemirror/autocomplete"
import { syntaxTree } from "@codemirror/language"
import type { EditorState } from "@codemirror/state"
import type { SyntaxNode } from "@lezer/common"
import { isScalar, isMap, isSeq, parseDocument, stringify, type YAMLMap } from "yaml"
import type { FactDescription } from "@/components/labeling-wire"
/** Catalog-driven completion for YAML keys, facts, operators, and published policies. */
export interface EditorContext {
  readonly catalog: ReadonlyArray<FactDescription>
  readonly referencePolicies: ReadonlyArray<{ name: string; target: string }>
}

const referenceNames = (context: EditorContext, target: unknown): readonly string[] =>
  context.referencePolicies
    .filter((policy) => target == null || policy.target === target)
    .map((policy) => policy.name)

const rootKeys = ["target", "appliesWhen", "matchesWhen", "classify"]
const conditionKeys = [
  "all",
  "any",
  "not",
  "fact",
  "operator",
  "value",
  "caseSensitive",
  "some",
  "every",
  "none",
  "where",
  "policy",
]
const classifierKeys = ["prompt", "evidence", "minimumConfidence"]
const isMapping = (node: SyntaxNode): boolean =>
  node.name === "BlockMapping" || node.name === "FlowMapping"

const enclosing = (
  node: SyntaxNode | null,
  predicate: (node: SyntaxNode) => boolean,
): SyntaxNode | null => {
  let current = node
  while (current !== null && !predicate(current)) current = current.parent
  return current
}

const stringValue = (state: EditorState, node: SyntaxNode | null): string | null => {
  if (node === null) return null
  const doc = parseDocument(state.sliceDoc(node.from, node.to))
  return doc.errors.length === 0 && isScalar(doc.contents) && typeof doc.contents.value === "string"
    ? doc.contents.value
    : null
}
const propertyName = (state: EditorState, pair: SyntaxNode): string | null =>
  stringValue(state, pair.getChild("Key"))
const siblingValue = (state: EditorState, mapping: SyntaxNode, key: string): string | null => {
  for (const pair of mapping.getChildren("Pair")) {
    if (propertyName(state, pair) === key && pair.lastChild?.name !== ":")
      return stringValue(state, pair.lastChild)
  }
  return null
}
const collectionFact = (
  state: EditorState,
  mapping: SyntaxNode | null,
  catalog: ReadonlyArray<FactDescription>,
): FactDescription | undefined => {
  let current = mapping
  while (current !== null) {
    if (isMapping(current)) {
      for (const key of ["some", "every", "none"]) {
        const name = siblingValue(state, current, key)
        if (name !== null) return catalog.find((fact) => fact.name === name)
      }
    }
    current = current.parent
  }
  return undefined
}
const valueCompletion = (label: string, detail: string): Completion => ({
  label,
  detail,
  type: "constant",
  apply: stringify(label, { lineWidth: 0 }).trimEnd(),
})

const valueOptions = (
  key: string | null,
  state: EditorState,
  mapping: SyntaxNode | null,
  context: EditorContext,
): ReadonlyArray<Completion> => {
  const root = syntaxTree(state).topNode.getChild("Document")?.firstChild
  const target = root && isMapping(root) ? siblingValue(state, root, "target") : null
  const catalog = context.catalog.filter(
    (fact) => target === null || fact.kinds.some((kind) => kind === target),
  )
  const inside = collectionFact(state, mapping, catalog)
  const factName = mapping === null ? null : siblingValue(state, mapping, "fact")
  const fact =
    inside === undefined
      ? catalog.find((entry) => entry.name === factName)
      : inside.fields.find((entry) => entry.name === factName)
  switch (key) {
    case "fact":
      return inside === undefined
        ? catalog
            .filter((entry) => entry.type !== "Collection")
            .map((entry) => valueCompletion(entry.name, entry.description))
        : inside.fields.map((field) =>
            valueCompletion(field.name, `${inside.name} · ${field.type}`),
          )
    case "operator":
      return (fact?.operators ?? []).map((operator) => valueCompletion(operator, "operator"))
    case "some":
    case "every":
    case "none":
      return catalog
        .filter((entry) => entry.type === "Collection")
        .map((entry) => valueCompletion(entry.name, entry.description))
    case "policy":
      return inside === undefined
        ? referenceNames(context, target).map((name) => valueCompletion(name, "published policy"))
        : []
    case "target":
      return ["pull_request", "issue"].map((name) => valueCompletion(name, "target"))
    case "evidence":
      return catalog
        .filter((entry) => entry.type !== "Collection")
        .map((entry) => valueCompletion(entry.name, "evidence"))
    case "caseSensitive":
      return ["true", "false"].map((label) => ({ label, type: "constant" }))
    case "value":
      if (fact?.type === "Flag")
        return ["true", "false"].map((label) => ({ label, type: "constant" }))
      return factName === "state"
        ? ["open", "closed"].map((value) => valueCompletion(value, "state"))
        : []
    default:
      return []
  }
}

/** Insert a temporary key so unfinished/empty lines have a real YAML mapping context. */
const keyContext = (state: EditorState, from: number, to: number, hasColon: boolean) => {
  const marker = "__policy_completion_cursor__"
  const document = parseDocument(
    state.sliceDoc(0, from) + marker + (hasColon ? "" : ": ") + state.sliceDoc(to),
  )
  type Location = { mapping: YAMLMap; path: string[]; collection: string | null; target: unknown }
  const target: unknown = isMap(document.contents) ? document.contents.get("target") : null
  const walk = (node: unknown, path: string[], collection: string | null): Location | null => {
    if (isMap(node)) {
      const localCollection = ["some", "every", "none"]
        .map((key) => node.get(key))
        .find((value) => typeof value === "string")
      for (const pair of node.items) {
        const key = isScalar(pair.key) ? String(pair.key.value) : ""
        if (key === marker) return { mapping: node, path, collection, target }
        const found = walk(
          pair.value,
          [...path, key],
          key === "where" && typeof localCollection === "string" ? localCollection : collection,
        )
        if (found) return found
      }
    } else if (isSeq(node)) {
      for (const item of node.items) {
        const found = walk(item, path, collection)
        if (found) return found
      }
    }
    return null
  }
  return walk(document.contents, [], null)
}

const quoted = (value: string) => stringify(value, { lineWidth: 0 }).trimEnd()
const field = (value: string) =>
  "${" + value.replace(/[{}]/g, "\\export const policyCompletionSource =") + "}"
const predicate = (fact: { name: string; type: string; operators: readonly string[] }): string => {
  const operator = fact.operators[0]
  const value =
    fact.type === "Flag"
      ? "false"
      : fact.name === "state"
        ? "open"
        : fact.name === "baseRef"
          ? "main"
          : "example"
  return (
    `fact: ${quoted(fact.name)}\noperator: ${operator}` +
    (["isEmpty", "notEmpty"].includes(operator ?? "")
      ? ""
      : `\nvalue: ${operator === "in" ? `[${field(quoted(value))}]` : field(fact.type === "Flag" ? value : quoted(value))}`)
  )
}
const indent = (source: string) =>
  source
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")

const keyOptions = (
  context: EditorContext,
  state: EditorState,
  from: number,
  to: number,
  hasColon: boolean,
  inList: boolean,
): Completion[] => {
  const location = keyContext(state, from, to, hasColon)
  if (!location) return []
  const { mapping, path, collection, target } = location
  const catalog = context.catalog.filter(
    (fact) => target == null || fact.kinds.some((kind) => kind === target),
  )
  const fields =
    collection === null
      ? catalog.filter((fact) => fact.type !== "Collection")
      : (catalog.find((fact) => fact.name === collection)?.fields ?? [])
  const sample = fields.find((fact) => fact.name === "state") ?? fields[0]
  const condition = sample ? predicate(sample) : null
  const existing = mapping.items.flatMap((pair) =>
    isScalar(pair.key) ? [String(pair.key.value)] : [],
  )
  const owner = path.at(-1)
  const isRoot = path.length === 0
  const isCondition = ["matchesWhen", "appliesWhen", "all", "any", "not", "where"].includes(
    owner ?? "",
  )
  let keys: string[] = []
  if (isRoot)
    keys = rootKeys.filter(
      (key) =>
        !(key === "classify" && existing.includes("matchesWhen")) &&
        !(key === "matchesWhen" && existing.includes("classify")),
    )
  else if (owner === "classify") keys = classifierKeys
  else if (isCondition) {
    if (["fact", "operator", "value", "caseSensitive"].some((key) => existing.includes(key))) {
      const fact = fields.find((fact) => fact.name === mapping.get("fact"))
      const operator = mapping.get("operator")
      keys = [
        "fact",
        "operator",
        ...(["isEmpty", "notEmpty"].includes(String(operator)) ? [] : ["value"]),
        ...(fact?.type === "Text" && !["isEmpty", "notEmpty"].includes(String(operator))
          ? ["caseSensitive"]
          : []),
      ]
    } else if (["some", "every", "none"].some((key) => existing.includes(key))) keys = ["where"]
    else if (["all", "any", "not", "policy"].some((key) => existing.includes(key))) keys = []
    else
      keys =
        collection === null
          ? conditionKeys.filter(
              (key) => !["operator", "value", "caseSensitive", "where"].includes(key),
            )
          : ["all", "any", "not", "fact"]
  }
  const options: Completion[] = []
  const add = (label: string, template: string, detail: string) => {
    options.push(
      snippetCompletion(inList ? template.replaceAll("\n", "\n  ") : template, {
        label,
        detail,
        type: "snippet",
      }),
    )
  }
  for (const key of keys.filter((key) => !existing.includes(key))) {
    if (hasColon) {
      options.push({ label: key, apply: key, type: "property" })
      continue
    }
    let template: string | null = null
    if (key === "target") template = `target: ${field("pull_request")}`
    else if (["matchesWhen", "appliesWhen", "not"].includes(key) && condition)
      template = `${key}:\n${indent(condition)}`
    else if (["all", "any"].includes(key) && condition)
      template = `${key}:\n  - ${condition.replaceAll("\n", "\n    ")}`
    else if (key === "where") {
      const name = ["some", "every", "none"]
        .map((key) => mapping.get(key))
        .find((value) => typeof value === "string")
      const item = catalog.find((fact) => fact.name === name)?.fields[0]
      if (item)
        template = `where:
${indent(predicate(item))}`
    } else if (
      key === "fact" &&
      condition &&
      !existing.some((key) => ["operator", "value", "caseSensitive"].includes(key))
    )
      template = condition
    else if (["some", "every", "none"].includes(key)) {
      const fact = catalog.find((fact) => fact.type === "Collection" && fact.fields.length > 0)
      if (fact)
        template = `${key}: ${quoted(fact.name)}\nwhere:\n${indent(predicate(fact.fields[0]!))}`
    } else if (key === "policy") {
      const names = referenceNames(context, target)
      if (names[0]) template = `policy: ${field(quoted(names[0]))}`
    } else if (key === "classify")
      template = `classify:\n  prompt: |\n    ${field("Does this describe a bug?")}\n  evidence: [${field("title")}]\n  minimumConfidence: ${field("0.8")}`
    else if (key === "prompt") template = `prompt: |\n  ${field("Does this describe a bug?")}`
    else if (key === "evidence") template = `evidence: [${field("title")}]`
    else if (key === "minimumConfidence") template = `minimumConfidence: ${field("0.8")}`
    if (template) add(key, template, "Insert section · Tab to edit fields")
    else if (!["policy", "some", "every", "none"].includes(key))
      options.push({ label: key, apply: `${key}: `, type: "property" })
  }
  if (
    isCondition &&
    keys.includes("fact") &&
    !hasColon &&
    !existing.some((key) => conditionKeys.includes(key))
  ) {
    for (const fact of fields.filter((fact) => fact.operators.length > 0))
      add(`Compare ${fact.name}`, predicate(fact), `fact · ${fact.type}`)
  }
  return options
}

export const policyCompletionSource =
  (context: EditorContext): CompletionSource =>
  (completionContext: CompletionContext) => {
    const { state, pos } = completionContext
    const line = state.doc.lineAt(pos)
    const before = state.sliceDoc(line.from, pos)
    // Whitespace beyond an unfinished scalar is outside Lezer's node range.
    const anchor = pos - (before.match(/\s*$/)?.[0].length ?? 0)
    const node = syntaxTree(state).resolveInner(anchor, -1)
    if (
      enclosing(node, (entry) => entry.name === "Comment" || entry.name.startsWith("BlockLiteral"))
    )
      return null
    const pair = enclosing(node, (entry) => entry.name === "Pair")
    const mapping = enclosing(node, isMapping)
    const key = pair === null ? null : propertyName(state, pair)
    const onKeyLine = /^\s*(?:-\s*)?[\w-]*$/.test(before)
    const inEvidence = key === "evidence" && /^\s*-\s*/.test(before)
    if (onKeyLine && !inEvidence) {
      if (!completionContext.explicit && before.trim().length === 0) return null
      const word = completionContext.matchBefore(/[\w-]*/)
      const from = word?.from ?? pos
      const to = pos + (state.sliceDoc(pos, line.to).match(/^[\w-]*/)?.[0].length ?? 0)
      const hasColon = /^\s*:/.test(state.sliceDoc(to, line.to))
      const options = keyOptions(context, state, from, to, hasColon, /^\s*-\s+/.test(before))
      return { from, to, options, validFor: /^[\w-]*$/ }
    }
    const options = valueOptions(key, state, mapping, context)
    if (options.length === 0) return null
    const scalar = enclosing(
      node,
      (entry) => entry.name === "Literal" || entry.name === "QuotedLiteral",
    )
    const from = scalar && scalar.from >= line.from ? scalar.from : pos
    const to = scalar && scalar.from >= line.from ? scalar.to : pos
    return { from, to, options, validFor: /^[\w .\-'"/]*$/ }
  }
