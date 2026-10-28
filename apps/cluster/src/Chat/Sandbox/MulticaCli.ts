/**
 * The `multica` CLI the chat sandbox image installs, pinned to a release of
 * multica-ai/multica. The bundled `multica-platform` skill (`MulticaSkill.ts`)
 * is copied from the same tag: bump both together with
 * `vp run chat:multica-skill` after changing the version and checksum here.
 */
export const MULTICA_CLI_VERSION = "0.7.0"

/** SHA-256 of `multica-cli-<version>-linux-amd64.tar.gz`, from the release's `checksums.txt`. */
export const MULTICA_CLI_SHA256 = "88afe0a4a1795dfd959f85764b94ef75f5639254fb77eecaa2e6528269b21bc7"
