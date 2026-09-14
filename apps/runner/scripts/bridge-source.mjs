// The bridge's source identity: one hash over the files that ship in the
// Sandbox image. The image build records it, the running bridge advertises
// it, and the release manifest pins it, so a runner can tell whether the
// container it reached is the one its release was tested against.
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

export const BRIDGE_SOURCES = ["archive.mjs", "entry.mjs", "publication.mjs", "server.mjs"]

export const bridgeSourceHash = (bridgeDir) => {
  const hash = createHash("sha256")
  for (const name of BRIDGE_SOURCES) {
    hash.update(name)
    hash.update("\0")
    hash.update(readFileSync(new URL(name, bridgeDir)))
    hash.update("\0")
  }
  return hash.digest("hex")
}
