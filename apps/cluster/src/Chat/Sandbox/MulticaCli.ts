/**
 * The `multica` CLI the chat sandbox image installs, pinned to a release of
 * multica-ai/multica. The bundled `multica-platform` skill (`MulticaSkill.ts`)
 * is copied from the same tag: bump both together with
 * `vp run chat:multica-skill` after changing the version and checksum here.
 */
export const MULTICA_CLI_VERSION = "0.9.0"

/** SHA-256 of `multica-cli-<version>-linux-amd64.tar.gz`, from the release's `checksums.txt`. */
export const MULTICA_CLI_SHA256 = "f9689733e715d07e16339ea26bf2c6ee9211c0a4934633ba91a3998f31a8798f"
