/**
 * Updates the chat sandbox's CLI pin in `src/Chat/Sandbox/MulticaCli.ts` from
 * the latest multica-ai/multica release. Run through `vp run chat:multica-cli-bump`,
 * then `vp run chat:multica-skill` so the bundled skill follows the new tag.
 */
import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import * as Schema from "effect/Schema"

const REPO = "multica-ai/multica"

const Release = Schema.Struct({
  tag_name: Schema.String,
  assets: Schema.Array(Schema.Struct({ name: Schema.String, browser_download_url: Schema.String })),
})

/** The `export const <name> = "..."` line, with the value in group 2. */
const pin = (name: string) => new RegExp(`^(export const ${name} = ")([^"]+)"$`, "m")
const VERSION = pin("MULTICA_CLI_VERSION")
const SHA256 = pin("MULTICA_CLI_SHA256")

/**
 * Writes the latest version and its linux-amd64 hash to `cliPath` together, or
 * nothing at all: a pin that already matches returns early, and a release without
 * the checksum fails before the file is touched.
 */
export const bumpMulticaCli = async (cliPath: string, fetch = globalThis.fetch): Promise<void> => {
  const get = async (url: string) => {
    const response = await fetch(url, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "janitor" },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`)
    return response
  }

  const source = await readFile(cliPath, "utf8")
  const pinned = VERSION.exec(source)?.[2]
  if (!pinned || !SHA256.test(source))
    throw new Error(`Cannot read the multica CLI pins in ${cliPath}`)

  const release = Schema.decodeUnknownSync(Release)(
    await get(`https://api.github.com/repos/${REPO}/releases/latest`).then((response) =>
      response.json(),
    ),
  )
  const version = /^v?(\d+\.\d+\.\d+)$/.exec(release.tag_name)?.[1]
  if (!version) throw new Error(`Invalid multica release tag: ${release.tag_name}`)
  if (version === pinned) return

  const checksums = release.assets.find((asset) => asset.name === "checksums.txt")
  if (!checksums) throw new Error(`No checksums.txt in multica ${release.tag_name}`)
  const filename = `multica-cli-${version}-linux-amd64.tar.gz`
  const hash = (await get(checksums.browser_download_url).then((response) => response.text()))
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === filename)?.[0]
  if (!hash || !/^[a-fA-F0-9]{64}$/.test(hash)) {
    throw new Error(`Missing or invalid linux-amd64 checksum for ${filename}`)
  }

  await writeFile(cliPath, source.replace(VERSION, `$1${version}"`).replace(SHA256, `$1${hash}"`))
}

if (import.meta.main) {
  await bumpMulticaCli(fileURLToPath(new URL("../src/Chat/Sandbox/MulticaCli.ts", import.meta.url)))
}
