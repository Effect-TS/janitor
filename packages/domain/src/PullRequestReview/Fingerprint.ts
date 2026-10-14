import * as Effect from "effect/Effect"
import * as Hex from "effect/encoding/Hex"
import * as Schema from "effect/Schema"

/**
 * A hash of a finding's path and its whitespace-normalised anchored lines. The
 * comment text is not an input (EFF-1649 rule 4).
 */
export const Fingerprint = Schema.NonEmptyString.pipe(Schema.brand("FindingFingerprint"))
export type Fingerprint = typeof Fingerprint.Type

/** Trims each line and collapses runs of whitespace, so re-indenting changes nothing. */
const normalise = (line: string) => line.trim().replace(/\s+/g, " ")

export const fingerprint = (
  path: string,
  lines: ReadonlyArray<string>,
): Effect.Effect<Fingerprint> =>
  Effect.promise(() =>
    crypto.subtle.digest(
      "SHA-256",
      // Neither a path nor a line can hold a newline, so joining on one is unambiguous.
      new TextEncoder().encode([path, ...lines.map(normalise)].join("\n")),
    ),
  ).pipe(Effect.map((digest) => Fingerprint.make(Hex.encode(new Uint8Array(digest)))))

/** A head blob of a path with an open janitor thread; `Unreadable` is missing or over 1 MB. */
export type HeadBlob =
  | { readonly _tag: "Read"; readonly text: string }
  | { readonly _tag: "Unreadable" }

/** Where the fingerprinted snippet sits in the head blob, if anywhere. */
export type HeadMatch =
  | { readonly _tag: "Matches"; readonly startLine: number; readonly endLine: number }
  | { readonly _tag: "Gone" }
  | { readonly _tag: "Unknown" }

/** Searches the whole head blob for `lineCount` consecutive lines with this fingerprint. */
export const matchAtHead = (
  target: { readonly path: string; readonly fingerprint: Fingerprint; readonly lineCount: number },
  blob: HeadBlob,
): Effect.Effect<HeadMatch> =>
  Effect.gen(function* () {
    if (blob._tag === "Unreadable") return { _tag: "Unknown" } as const
    const lines = blob.text.split("\n")
    for (let start = 0; target.lineCount > 0 && start + target.lineCount <= lines.length; start++) {
      const window = lines.slice(start, start + target.lineCount)
      if ((yield* fingerprint(target.path, window)) === target.fingerprint) {
        return { _tag: "Matches", startLine: start + 1, endLine: start + target.lineCount } as const
      }
    }
    return { _tag: "Gone" } as const
  })
