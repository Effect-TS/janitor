import * as Option from "effect/Option"

/** Returns the `rel="next"` URL from a GitHub `Link` header, if present. */
export const nextLink = (link: string): Option.Option<string> => {
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*(?:[^,]*;\s*)?rel="next"/.exec(part.trim())
    if (match?.[1] !== undefined) {
      return Option.some(match[1])
    }
  }
  return Option.none()
}
