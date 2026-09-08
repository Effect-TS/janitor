import { assert, describe, it } from "@effect/vitest"
import ClusterWorker from "../src/Worker.ts"

describe("ClusterWorker", () => {
  it("constructs the Alchemy Worker module", () => {
    assert.isFunction(ClusterWorker)
  })
})
