/**
 * The `multica` CLI the chat sandbox image installs, pinned to a release of
 * multica-ai/multica. The bundled `multica-platform` skill (`MulticaSkill.ts`)
 * is copied from the same tag: bump both together with
 * `vp run chat:multica-skill` after changing the version and checksum here.
 */
export const MULTICA_CLI_VERSION = "0.13.0"

/** SHA-256 of `multica-cli-<version>-linux-amd64.tar.gz`, from the release's `checksums.txt`. */
export const MULTICA_CLI_SHA256 = "82b2b92891f4b51344facfa9f917f067a926453315c6bb87d1f02294635fc4ec"
