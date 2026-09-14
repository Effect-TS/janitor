// The pinned release manifest must agree with every artifact it claims to pin.
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vite-plus/test"
import packageJson from "../package.json" with { type: "json" }
import {
  RELEASE_MANIFEST,
  SUPPORTED_NATIVE_MIGRATIONS,
  manifestProblems,
} from "../src/ReleaseManifest.ts"

const root = new URL("..", import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), "utf8")

describe("release manifest", () => {
  it("agrees with the compiled protocol and native migration set", () => {
    expect(manifestProblems()).toEqual([])
    expect(RELEASE_MANIFEST.nativeMigrations.ids).toEqual(SUPPORTED_NATIVE_MIGRATIONS)
  })

  it("pins the dependency graph the bundle is built from", () => {
    expect(packageJson.dependencies["@opencode/core"]).toBe(RELEASE_MANIFEST.build.opencode)
    expect(packageJson.dependencies["@opencode/sdk"]).toBe(RELEASE_MANIFEST.build.opencode)
    expect(packageJson.dependencies.effect).toBe("catalog:")
    const require = createRequire(import.meta.url)
    expect(require("effect/package.json").version).toBe(RELEASE_MANIFEST.build.effect)
    expect(read("../../pnpm-workspace.yaml")).toContain(
      `effect: ${RELEASE_MANIFEST.build.effectSource}`,
    )
    expect(RELEASE_MANIFEST.nativeMigrations.package).toBe(
      `@opencode/core@${RELEASE_MANIFEST.build.opencode}`,
    )
    const stack = read("../../stacks/runner.ts")
    expect(stack).toContain(RELEASE_MANIFEST.build.compatibilityDate)
    for (const flag of RELEASE_MANIFEST.build.compatibilityFlags) expect(stack).toContain(flag)
  })

  it("declares the SQLite workspace and its bounded tools", () => {
    expect(RELEASE_MANIFEST.workspace.storage).toBe("sqlite")
    expect(RELEASE_MANIFEST.workspace.tools).not.toContain("shell")
    expect(RELEASE_MANIFEST.workspace.tools).toContain("publish")
  })
})
