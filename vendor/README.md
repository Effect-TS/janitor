# Pinned Effect artifacts

The backend uses Effect revision `f4143802256d135864f15314fc37385e919999b1`, matching the existing Cloudflare integration tarball. The frontend retains its registry Effect dependency for Foldkit. No sibling checkout is needed to install, test, or deploy this repository.

`effect-artifacts.json` records SHA-256 hashes. The lockfile additionally pins package integrity. `vp run vendor:effect` regenerates the Effect and Vitest artifacts from that committed revision in `../effect`, excluding working-tree changes. The generator emits JavaScript and declarations with TypeScript 7.0.2 and preserves the upstream license. It does not upgrade the Cloudflare integration artifact.

Validate regenerated artifacts with `vp install`, `vp check`, and `vp test`, review the Worker bundle and deployment plan before changing the pin in production.
