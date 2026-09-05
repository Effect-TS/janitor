import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  type Completion,
  type CompletionContext,
  type CompletionSource,
  completionKeymap,
} from "@codemirror/autocomplete"
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { yaml } from "@codemirror/lang-yaml"
import * as Result from "effect/Result"
import { isScalar, parseDocument, stringify } from "yaml"
import { inspect, formatDocument } from "./format"
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  syntaxTree,
} from "@codemirror/language"
import { lintGutter, linter, lintKeymap } from "@codemirror/lint"
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search"
import { Compartment, type EditorState, type Extension } from "@codemirror/state"
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  ViewPlugin,
} from "@codemirror/view"
import type { SyntaxNode } from "@lezer/common"
import { githubDark, githubLight } from "@uiw/codemirror-theme-github"
import type { FactDescription } from "@/components/labeling-wire"

/** Catalog-driven completion for YAML keys, facts, operators, and published policies. */
export interface EditorContext {
  readonly catalog: ReadonlyArray<FactDescription>
  readonly policyNames: ReadonlyArray<string>
}

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
      return context.policyNames.map((name) => valueCompletion(name, "published policy"))
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
      const keys =
        /^\S/.test(before) || before.length === 0
          ? rootKeys
          : key === "classify"
            ? classifierKeys
            : conditionKeys
      const hasColon = /^\s*:/.test(state.sliceDoc(pos, line.to))
      return {
        from: word?.from ?? pos,
        options: keys.map((label) => ({
          label,
          apply: hasColon ? label : `${label}: `,
          type: "property",
        })),
        validFor: /^[\w-]*$/,
      }
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

const yamlLinter = linter((view) =>
  Result.match(inspect(view.state.doc.toString()), {
    onSuccess: () => [],
    onFailure: ({ message, from, to }) => [
      {
        from: Math.min(from, view.state.doc.length),
        to: Math.min(to, view.state.doc.length),
        severity: "error" as const,
        message,
      },
    ],
  }),
)

const editorTheme = EditorView.theme({
  "&": { minHeight: "18rem", maxHeight: "36rem", fontSize: "13px" },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
  ".cm-content": { padding: "12px 0" },
  "&.cm-focused": { outline: "none" },
})

export const formatEditor = (id: string): string => {
  const element = document.getElementById(id)?.querySelector(".cm-editor")
  const editor = element instanceof HTMLElement ? EditorView.findFromDOM(element) : null
  if (!editor) throw new Error("The editor is not ready yet")
  const current = editor.state.doc.toString()
  const formatted = Result.getOrThrow(formatDocument(current))
  if (formatted !== current)
    editor.dispatch({
      changes: { from: 0, to: current.length, insert: formatted },
      userEvent: "input.format",
    })
  return formatted
}

const currentTheme = (): Extension =>
  document.documentElement.classList.contains("dark") ? githubDark : githubLight

/** Follows the app's theme switcher, which toggles `dark` on the root element. */
const followTheme = (theme: Compartment) =>
  ViewPlugin.fromClass(
    class {
      readonly observer: MutationObserver
      constructor(view: EditorView) {
        this.observer = new MutationObserver(() => {
          view.dispatch({ effects: theme.reconfigure(currentTheme()) })
        })
        this.observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["class"],
        })
      }
      destroy() {
        this.observer.disconnect()
      }
    },
  )

export const createPolicySourceEditor = (input: {
  readonly element: HTMLElement
  readonly initialSource: string
  readonly context: EditorContext
  readonly onChange: (source: string) => void
}): EditorView => {
  const theme = new Compartment()
  return new EditorView({
    doc: input.initialSource,
    parent: input.element,
    extensions: [
      theme.of(currentTheme()),
      followTheme(theme),
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter({
        markerDOM: (open) => {
          const marker = document.createElement("span")
          marker.className = "policy-fold-marker"
          marker.title = open ? "Fold section" : "Unfold section"
          const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
          svg.setAttribute("viewBox", "0 0 12 12")
          svg.setAttribute("width", "12")
          svg.setAttribute("height", "12")
          svg.setAttribute("fill", "none")
          svg.setAttribute("stroke", "currentColor")
          svg.setAttribute("stroke-width", "1.5")
          svg.setAttribute("stroke-linecap", "round")
          svg.setAttribute("stroke-linejoin", "round")
          svg.setAttribute("aria-hidden", "true")
          const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
          path.setAttribute("d", open ? "M3 4.5 6 7.5 9 4.5" : "M4.5 3 7.5 6 4.5 9")
          svg.append(path)
          marker.append(svg)
          return marker
        },
      }),
      drawSelection(),
      dropCursor(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      yaml(),
      indentUnit.of("  "),
      yamlLinter,
      lintGutter(),
      autocompletion({
        override: [policyCompletionSource(input.context)],
        activateOnTyping: true,
        selectOnOpen: true,
      }),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        ...lintKeymap,
      ]),
      EditorView.contentAttributes.of({ "aria-label": "Policy program YAML" }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) input.onChange(update.state.doc.toString())
      }),
      editorTheme,
    ],
  })
}
