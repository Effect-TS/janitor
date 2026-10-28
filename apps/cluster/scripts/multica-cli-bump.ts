/** Updates the chat sandbox's CLI pin from the latest multica-ai/multica release. */
import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import * as Schema from "effect/Schema"

const Release = Schema.Struct({
  tag_name: Schema.String,
  assets: Schema.Array(Schema.Struct({ name: Schema.String, browser_download_url: Schema.String })),
})

/** Validates the release and checksum before writing either pin. An up-to-date pin is not written. */
export const bumpMulticaCli = async ({
  cliPath,
  fetch,
}: {
  readonly cliPath: string
  readonly fetch: typeof globalThis.fetch
}): Promise<void> => {
  const source = await readFile(cliPath, "utf8")
  const versionPattern = /^(export const MULTICA_CLI_VERSION = ")([^"]+)(")$/m
  const hashPattern = /^(export const MULTICA_CLI_SHA256 = ")([a-fA-F0-9]{64})(")$/m
  const pinned = versionPattern.exec(source)?.[2]
  if (!pinned || !hashPattern.test(source)) throw new Error("Cannot read the multica CLI pins")

  const response = await fetch("https://api.github.com/repos/multica-ai/multica/releases/latest", {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "janitor" },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`Latest multica release request failed: ${response.status}`)
  const release = Schema.decodeUnknownSync(Release)(await response.json())
  const version = /^v?(\d+\.\d+\.\d+)$/.exec(release.tag_name)?.[1]
  if (!version) throw new Error(`Invalid multica release tag: ${release.tag_name}`)
  if (version === pinned) return

  const asset = release.assets.find((asset) => asset.name === "checksums.txt")
  if (!asset) throw new Error(`No checksums.txt in multica ${release.tag_name}`)
  const checksums = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(30_000) })
  if (!checksums.ok) throw new Error(`Multica checksums request failed: ${checksums.status}`)
  const filename = `multica-cli-${version}-linux-amd64.tar.gz`
  const entry = (await checksums.text())
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name?.replace(/^\*/, "") === filename)
  const hash = entry?.[0]
  if (!hash || !/^[a-fA-F0-9]{64}$/.test(hash)) {
    throw new Error(`Missing or invalid linux-amd64 checksum for ${filename}`)
  }

  await writeFile(
    cliPath,
    source
      .replace(versionPattern, (_, prefix, _old, suffix) => `${prefix}${version}${suffix}`)
      .replace(hashPattern, (_, prefix, _old, suffix) => `${prefix}${hash}${suffix}`),
  )
}

if (import.meta.main) {
  await bumpMulticaCli({
    cliPath: fileURLToPath(new URL("../src/Chat/Sandbox/MulticaCli.ts", import.meta.url)),
    fetch: globalThis.fetch,
  })
}
