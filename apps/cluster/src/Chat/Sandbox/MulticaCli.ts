/**
 * The `multica` CLI the chat sandbox image installs, pinned to a release of
 * multica-ai/multica. The bundled `multica-platform` skill (`MulticaSkill.ts`)
 * is copied from the same tag: bump both together with
 * `vp run chat:multica-skill` after changing the version and checksum here.
 */
export const MULTICA_CLI_VERSION = "0.11.1"

/** SHA-256 of `multica-cli-<version>-linux-amd64.tar.gz`, from the release's `checksums.txt`. */
export const MULTICA_CLI_SHA256 = "e59fd0db93bb184cc5349ff60d0d982f8d2ce46355269bec879eb12dfe61c003"
