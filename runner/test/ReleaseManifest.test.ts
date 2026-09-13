// The pinned release manifest must agree with every artifact it claims to pin.
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { bridgeSourceHash } from "../scripts/bridge-source.mjs"
import { capabilities, protocol } from "../bridge/server.mjs"
import bridgeRelease from "../bridge/release.json" with { type: "json" }
import bridgeBuild from "../bridge/build.json" with { type: "json" }
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
    expect(packageJson.dependencies.effect).toBe(RELEASE_MANIFEST.build.effect)
    expect(packageJson.dependencies["@cloudflare/sandbox"]).toBe(RELEASE_MANIFEST.build.sandboxSdk)
    expect(RELEASE_MANIFEST.nativeMigrations.package).toBe(
      `@opencode/core@${RELEASE_MANIFEST.build.opencode}`,
    )
    const wrangler = read("wrangler.jsonc")
    expect(wrangler).toContain(
      `"compatibility_date": "${RELEASE_MANIFEST.build.compatibilityDate}"`,
    )
    expect(wrangler).toContain(
      `"compatibility_flags": ${JSON.stringify(RELEASE_MANIFEST.build.compatibilityFlags)}`,
    )
  })

  it("pins the bridge image, protocol and capabilities the runner requires", () => {
    expect(RELEASE_MANIFEST.bridge.protocol).toBe(protocol)
    // The Dockerfile enables process isolation; those capabilities are advertised at runtime.
    const advertised = [...capabilities, "pid-namespace-v1", "workspace-user-v1"]
    for (const capability of RELEASE_MANIFEST.bridge.required)
      expect(advertised).toContain(capability)
    expect(RELEASE_MANIFEST.bridge.sourceHash).toBe(bridgeSourceHash(new URL("bridge/", root)))
    expect(bridgeBuild.sourceHash).toBe(RELEASE_MANIFEST.bridge.sourceHash)
    expect(bridgeRelease.sourceHash).toBe(RELEASE_MANIFEST.bridge.sourceHash)
    expect(bridgeRelease.imageDigest).toBe(RELEASE_MANIFEST.bridge.imageDigest)
    expect(bridgeRelease.imageId).toBe(RELEASE_MANIFEST.bridge.imageId)
    expect(bridgeRelease.baseImage).toBe(RELEASE_MANIFEST.bridge.baseImage)
    expect(bridgeRelease.sandboxSdk).toBe(RELEASE_MANIFEST.build.sandboxSdk)
    expect(read("bridge/Dockerfile")).toContain(
      `FROM docker.io/${RELEASE_MANIFEST.bridge.baseImage}`,
    )
  })

  it("pins the checkpoint archive format the bridge writes and restores", () => {
    const archive = read("bridge/archive.mjs")
    for (const format of RELEASE_MANIFEST.checkpoint.archiveFormats)
      expect(archive).toContain(`"${format}"`)
  })
})
