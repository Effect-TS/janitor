import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vite-plus/test"
import { bumpMulticaCli } from "../../scripts/multica-cli-bump.ts"

const original = `/** Keep this comment. */
export const MULTICA_CLI_VERSION = "0.7.0"

/** SHA-256 of the linux-amd64 tarball. */
export const MULTICA_CLI_SHA256 = "88afe0a4a1795dfd959f85764b94ef75f5639254fb77eecaa2e6528269b21bc7"
`
const latestUrl = "https://api.github.com/repos/multica-ai/multica/releases/latest"
const checksumsUrl = "https://github.com/multica-ai/multica/releases/download/v0.7.1/checksums.txt"
const directories: Array<string> = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const pinFile = async () => {
  const directory = await mkdtemp(join(tmpdir(), "multica-cli-bump-"))
  directories.push(directory)
  const path = join(directory, "MulticaCli.ts")
  await writeFile(path, original)
  // Identical bytes written again are still a write. Give the fixture a recognisable timestamp.
  await utimes(path, 0, 0)
  return path
}

const github =
  (tag: string, checksums?: string): typeof globalThis.fetch =>
  async (input) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url === latestUrl) {
      return Response.json({
        tag_name: tag,
        assets: [{ name: "checksums.txt", browser_download_url: checksumsUrl }],
      })
    }
    if (url === checksumsUrl && checksums !== undefined) return new Response(checksums)
    throw new Error(`Unexpected HTTP request: ${url}`)
  }

describe("multica CLI bump", () => {
  it("fails without a linux-amd64 checksum and writes nothing", async () => {
    const path = await pinFile()
    const before = await stat(path)

    await expect(
      bumpMulticaCli(
        path,
        github(
          "v0.7.1",
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  multica-cli-0.7.1-linux-arm64.tar.gz\n",
        ),
      ),
    ).rejects.toThrow(/linux-amd64/)

    expect(await readFile(path, "utf8")).toBe(original)
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs)
  })

  it("leaves a matching pin untouched without downloading checksums", async () => {
    const path = await pinFile()
    const before = await stat(path)

    await bumpMulticaCli(path, github("v0.7.0"))

    expect(await readFile(path, "utf8")).toBe(original)
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs)
  })

  it("writes the latest version and its linux-amd64 hash together", async () => {
    const path = await pinFile()

    await bumpMulticaCli(
      path,
      github(
        "v0.7.1",
        `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  multica-cli-0.7.1-linux-arm64.tar.gz
0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  multica-cli-0.7.1-linux-amd64.tar.gz
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  multica-cli-0.7.1-darwin-amd64.tar.gz
`,
      ),
    )

    expect(await readFile(path, "utf8")).toBe(`/** Keep this comment. */
export const MULTICA_CLI_VERSION = "0.7.1"

/** SHA-256 of the linux-amd64 tarball. */
export const MULTICA_CLI_SHA256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
`)
  })
})
