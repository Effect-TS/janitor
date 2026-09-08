import { assert, describe, it } from "@effect/vitest"
import * as Option from "effect/Option"
import { nextLink } from "../../src/GitHub/Link.ts"

describe("nextLink", () => {
  it("finds the next relation among others", () => {
    const header =
      '<https://api.github.com/installation/repositories?per_page=100&page=3>; rel="next", ' +
      '<https://api.github.com/installation/repositories?per_page=100&page=5>; rel="last"'
    assert.deepStrictEqual(
      nextLink(header),
      Option.some("https://api.github.com/installation/repositories?per_page=100&page=3"),
    )
  })

  it("returns none on the final page", () => {
    assert.deepStrictEqual(
      nextLink(
        '<https://api.github.com/x?page=1>; rel="first", <https://api.github.com/x?page=2>; rel="prev"',
      ),
      Option.none(),
    )
    assert.deepStrictEqual(nextLink(""), Option.none())
  })
})
