import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { yaml } from "@codemirror/lang-yaml"
import * as Result from "effect/Result"
import { inspect, formatDocument } from "./format"
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
} from "@codemirror/language"
import { lintGutter, linter, lintKeymap } from "@codemirror/lint"
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search"
import { Compartment, type Extension } from "@codemirror/state"
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
import { githubDark, githubLight } from "@uiw/codemirror-theme-github"
import { policyCompletionSource, type EditorContext } from "./completion"
export { policyCompletionSource } from "./completion"

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
        indentWithTab,
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
