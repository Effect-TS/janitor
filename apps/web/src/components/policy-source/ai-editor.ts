import { Compartment } from "@codemirror/state"
import {
  autocompletion,
  completionKeymap,
  acceptCompletion,
  type CompletionContext,
} from "@codemirror/autocomplete"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { EditorView, keymap, ViewPlugin, Decoration, type DecorationSet } from "@codemirror/view"
import { linter, forceLinting } from "@codemirror/lint"
import { githubDark, githubLight } from "@uiw/codemirror-theme-github"
import { inspectAiPrompt } from "@janitor/domain/Labeling/Policy/PromptReferences"
import type { FactDescription } from "../labeling-wire"

export const aiCompletion =
  (catalog: ReadonlyArray<FactDescription>, target: string) => (context: CompletionContext) => {
    const match = context.matchBefore(/\{\{(?:fact:)?[a-zA-Z]*/)
    if (!match) return null
    return {
      from: match.from,
      filter: false,
      options: catalog
        .filter(
          (fact) =>
            fact.kinds.some((kind) => kind === target) &&
            fact.name
              .toLowerCase()
              .includes(match.text.replace(/^\{\{(?:fact:)?/, "").toLowerCase()),
        )
        .map((fact) => ({
          label: `{{fact:${fact.name}}}`,
          detail: fact.type,
          info: fact.description,
          apply: (view: EditorView, _completion: unknown, from: number, to: number) => {
            const end = view.state.sliceDoc(to, to + 2) === "}}" ? to + 2 : to
            const insert = `{{fact:${fact.name}}}`
            view.dispatch({
              changes: { from, to: end, insert },
              selection: { anchor: from + insert.length },
              userEvent: "input.complete",
            })
          },
        })),
    }
  }
const marks = (view: EditorView) =>
  Decoration.set(
    [...view.state.doc.toString().matchAll(/\{\{fact:[a-zA-Z]+\}\}/g)].map((m) =>
      Decoration.mark({ class: "ai-fact-reference" }).range(m.index, m.index + m[0].length),
    ),
  )
export const createAiPromptEditor = (
  element: HTMLElement,
  source: string,
  catalog: ReadonlyArray<FactDescription>,
  onChange: (value: string) => void,
): EditorView => {
  const theme = new Compartment()
  const currentTheme = () =>
    document.documentElement.classList.contains("dark") ? githubDark : githubLight
  const readCatalog = (): ReadonlyArray<FactDescription> =>
    element.dataset.catalog ? JSON.parse(element.dataset.catalog) : catalog
  return new EditorView({
    parent: element,
    doc: source,
    extensions: [
      theme.of(currentTheme()),
      ViewPlugin.fromClass(
        class {
          observer: MutationObserver
          constructor(view: EditorView) {
            this.observer = new MutationObserver(() => {
              view.dispatch({ effects: theme.reconfigure(currentTheme()) })
              forceLinting(view)
            })
            this.observer.observe(document.documentElement, {
              attributes: true,
              attributeFilter: ["class"],
            })
            this.observer.observe(element, {
              attributes: true,
              attributeFilter: ["data-target", "data-catalog"],
            })
          }
          destroy() {
            this.observer.disconnect()
          }
        },
      ),
      history(),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ "aria-label": "AI rule instructions" }),
      EditorView.theme({
        "&": { minHeight: "20rem", fontSize: "13px" },
        ".cm-content": { padding: "16px", lineHeight: "1.8" },
        ".cm-scroller": { overflow: "auto" },
      }),
      autocompletion({
        override: [
          (context) =>
            aiCompletion(readCatalog(), element.dataset.target ?? "pull_request")(context),
        ],
        selectOnOpen: true,
      }),
      keymap.of([
        ...completionKeymap,
        { key: "Tab", run: acceptCompletion },
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      linter((view) =>
        inspectAiPrompt(
          view.state.doc.toString(),
          element.dataset.target ?? "pull_request",
          readCatalog(),
        ).diagnostics.map((d) => ({ ...d, severity: "error" as const })),
      ),
      ViewPlugin.fromClass(
        class {
          decorations: DecorationSet
          constructor(view: EditorView) {
            this.decorations = marks(view)
          }
          update(update: { docChanged: boolean; view: EditorView }) {
            if (update.docChanged) this.decorations = marks(update.view)
          }
        },
        { decorations: (v) => v.decorations },
      ),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChange(update.state.doc.toString())
      }),
    ],
  })
}
