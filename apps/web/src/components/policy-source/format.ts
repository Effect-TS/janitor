import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { parseDocument, stringify } from "yaml"

interface SourceIssue {
  readonly message: string
  readonly from: number
  readonly to: number
}

/** YAML is an authoring format; the API and stored programs remain JSON values. */
export const inspect = (source: string): Result.Result<Record<string, unknown>, SourceIssue> => {
  const document = parseDocument(source, { version: "1.2", schema: "core", stringKeys: true })
  const issue = document.errors[0] ?? document.warnings[0]
  if (issue !== undefined) {
    return Result.fail({
      message: `Invalid YAML: ${issue.message}`,
      from: issue.pos[0],
      to: issue.pos[1],
    })
  }
  return Result.try({
    try: () => {
      // Policy reuse uses `policy: name`, not YAML aliases or custom object types.
      const value: unknown = document.toJS({ maxAliasCount: 0 })
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("The program must be a YAML mapping")
      }
      if (!Schema.is(Schema.Json)(value))
        throw new Error("Use plain YAML values and finite numbers")
      return value as Record<string, unknown>
    },
    catch: (error) => ({
      message: `Invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
      from: 0,
      to: source.indexOf("\n") === -1 ? source.length : source.indexOf("\n"),
    }),
  })
}

export const parse = (source: string): Result.Result<Record<string, unknown>, string> =>
  Result.mapError(inspect(source), (issue) => issue.message)

export const format = (source: unknown): string => stringify(source, { indent: 2, lineWidth: 0 })

/** Reformat the YAML document rather than its JS value so comments survive. */
export const formatDocument = (source: string): Result.Result<string, string> =>
  Result.map(parse(source), () =>
    parseDocument(source, { version: "1.2", schema: "core", stringKeys: true }).toString({
      indent: 2,
      lineWidth: 0,
    }),
  )
