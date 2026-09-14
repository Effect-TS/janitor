# Runner integration progress

Worktree: `/home/maxwellbrown/.t3/worktrees/janitor/runner-project-integration`

Branch: `feat/runner-project-integration`

Base: `7c32b3a`, main after Slack acknowledgement/delivery PR #37.

## Dependency decision

The initial probe in `probes/effect-graphs.json` is historical evidence from the separate installations. Both reported Effect 4.0.0-rc.112, but resolved to different modules. Basic cross-graph services worked. The native candidate then failed at startup because the root snapshot exports `Config.Redacted`, while OpenCode called `Config.redacted`. Bundling also found old `Config.string` calls in OpenCode simulation and mismatched Effect platform packages.

Following the request to patch the SDK, the root workspace applies versioned patches to OpenCode AI and simulation 2.0.2. Effect platform packages and OpenTelemetry resolve to the same commit as Effect. The AI patch also takes over the existing OpenRouter request serialization workaround. Application code uses the native `OpenRouter.route` again.

`apps/runner` is now a root workspace application, installed through the root lockfile. Run the current graph probe from the root:

```sh
node .scratch/runner-production-integration/probes/shared-graph.mjs
```

It verifies that the root, runner, OpenCode AI/core and Alchemy resolve the same Effect module. This is dependency evidence, not proof of Alchemy runtime adapter compatibility.

## Implementation

Root checks include runner source and native tests. Root tasks expose type checking, production bundling, native tests and bridge tests. PR and deployment CI require those checks without production credentials. Deployment declarations are extracted into `stacks/runner.ts` with the existing resource IDs and names. Build cache inputs now include the root lockfile, workspace configuration and patches.

The existing image-build-before-Worker sequence remains in place. Moving image publishing into the Container provider introduces a dependency between its application output and the Worker bundle. That sequence needs a separate graph validation and cutover; this SDK patch does not establish it. No infrastructure was deployed or replaced.

The Config adaptation passed native streaming, tools, compaction and maintenance/checkpoint recovery against the root graph. After moving OpenRouter serialization into the SDK, an installation failure initially left the old package linked; correcting the workspace configuration and reinstalling resolved the request failure. Frozen installation, runner type checking, production bundling, the controlled OpenRouter test and all 12 bridge tests pass. The release manifest records the exact Effect source in addition to its reported version.

## Remaining integration slices

The SDK/workspace change removes the dependency-isolation obstacle. The remaining plan covers Alchemy-owned image publishing, runtime checkpoint/Sandbox/authority services, full local composition, release timing diagnostics and a disposable-resource deployment before production validation. The `runner:dev` task is a native local service fixture, not the completed backend/repository composition. Paid provider and live publication checks remain explicitly gated.

## Final validation for the SDK/workspace change

`vp test` passed 708 tests across 127 passing files, with 4 tests and 3 files explicitly skipped, in 577.80 seconds. This includes the backend-to-runner acceptance driver and the runner's native recovery and model scenarios. `vp check` completed with zero errors; existing runner diagnostics are now visible as warnings under the root checks. Runner type checking, production bundling, frozen installation and all 12 bridge tests passed.

The deployment build also passed using the existing local Sandbox image at its immutable digest. Its generated image source hash and digest match the generated release manifest, and the production bundle excludes the test entry's fault routes. Registry publishing, live Cloudflare resource changes, paid-provider requests and live GitHub publication were not performed.
