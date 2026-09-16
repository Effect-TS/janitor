import * as Schema from "effect/Schema"

export const Ref = Schema.NonEmptyString.check(Schema.isPattern(/^[^-\s\0][^\s\0]*$/))

/** Clone URL without embedded credentials. */
export const Remote = Schema.Struct({
  url: Schema.NonEmptyString.check(
    Schema.makeFilter((url) => {
      if (url.includes("\0") || url.startsWith("-")) return "invalid clone URL"
      if (/^https?:\/\//i.test(url)) {
        try {
          const parsed = new URL(url)
          return (!parsed.username && !parsed.password) || "clone URLs must not contain credentials"
        } catch {
          return "invalid HTTP clone URL"
        }
      }
      return true
    }),
  ),
  defaultBranch: Schema.optionalKey(Ref),
})
export type Remote = typeof Remote.Type

export const defaultBranch = (remote: Remote): string => remote.defaultBranch ?? "main"
