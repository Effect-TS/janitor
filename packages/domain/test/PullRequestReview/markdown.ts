/**
 * A CommonMark reading of fenced code blocks and code spans, independent of
 * the code under test.
 */

const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/
const closing = /^ {0,3}(`{3,}|~{3,})\s*$/

/** Each line, and whether it is content inside a fenced code block. */
export const fencedLines = (markdown: string) => {
  let fence: string | undefined
  return markdown.split("\n").map((line) => {
    if (fence === undefined) {
      const open = opening.exec(line)
      if (open !== null && !(open[1]![0] === "`" && open[2]!.includes("`"))) fence = open[1]
      return { line, fenced: false }
    }
    const close = closing.exec(line)
    if (close !== null && close[1]![0] === fence[0] && close[1]!.length >= fence.length) {
      fence = undefined
      return { line, fenced: false }
    }
    return { line, fenced: true }
  })
}

/** The text outside fenced code blocks and code spans; a backslash-escaped backtick opens no span. */
export const outsideCode = (markdown: string) =>
  fencedLines(markdown)
    .map(({ line, fenced }) => (fenced ? "" : line))
    .join("\n")
    .replace(/(?<!\\)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, "")
