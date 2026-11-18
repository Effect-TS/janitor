/**
 * The `multica` CLI the chat sandbox image installs, pinned to a release of
 * multica-ai/multica. The bundled `multica-platform` skill (`MulticaSkill.ts`)
 * is copied from the same tag: bump both together with
 * `vp run chat:multica-skill` after changing the version and checksum here.
 */
export const MULTICA_CLI_VERSION = "0.11.0"

/** SHA-256 of `multica-cli-<version>-linux-amd64.tar.gz`, from the release's `checksums.txt`. */
export const MULTICA_CLI_SHA256 = "0d5150c8257d814c29b82e091d2da393deb5fc0306d8c391fda66c557e0993ea"
