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

## SDK/workspace implementation history

Root checks include runner source and native tests. Root tasks expose type checking, production bundling, native tests and bridge tests. PR and deployment CI require those checks without production credentials. Deployment declarations are extracted into `stacks/runner.ts` with the existing resource IDs and names. Build cache inputs now include the root lockfile, workspace configuration and patches.

The existing image-build-before-Worker sequence remains in place. Moving image publishing into the Container provider introduces a dependency between its application output and the Worker bundle. That sequence needs a separate graph validation and cutover; this SDK patch does not establish it. No infrastructure was deployed or replaced.

The Config adaptation passed native streaming, tools, compaction and maintenance/checkpoint recovery against the root graph. After moving OpenRouter serialization into the SDK, an installation failure initially left the old package linked; correcting the workspace configuration and reinstalling resolved the request failure. Frozen installation, runner type checking, production bundling, the controlled OpenRouter test and all 12 bridge tests pass. The release manifest records the exact Effect source in addition to its reported version.

## Integration scope after the SDK patch

At that commit, the SDK/workspace change removed the dependency-isolation obstacle. The subsequent integration covered Alchemy-owned image publishing, runtime checkpoint/Sandbox/authority services, full local composition, release timing diagnostics and a disposable-resource deployment before production validation. At that point, `runner:dev` was a native local service fixture. The completed application composition is recorded below. Paid provider and live publication checks remain explicitly gated.

## Final validation for the SDK/workspace change

`vp test` passed 708 tests across 127 passing files, with 4 tests and 3 files explicitly skipped, in 577.80 seconds. This includes the backend-to-runner acceptance driver and the runner's native recovery and model scenarios. `vp check` completed with zero errors; existing runner diagnostics are now visible as warnings under the root checks. Runner type checking, production bundling, frozen installation and all 12 bridge tests passed.

The deployment build also passed using the existing local Sandbox image at its immutable digest. Its generated image source hash and digest match the generated release manifest, and the production bundle excludes the test entry's fault routes. Registry publishing, live Cloudflare resource changes, paid-provider requests and live GitHub publication were not performed.

## Completed runner integration

The runner is now part of the root Alchemy local and production compositions. `AgentSandboxImage` owns verified image publication using Alchemy Docker and the Effect Cloudflare registry client. `AgentRunnerBuild` consumes its immutable digest. The original Worker, Durable Object, container and bucket resource identities remain unchanged. Raw registry REST/build-push glue and standalone Wrangler configuration were removed. Local/test image builds also use Alchemy Docker.

The native Durable Object is a thin entry point. A per-object Effect runtime composes command handling, admission, compatibility, projection, maintenance, supervision and native runtime ownership. Repository authority, Sandbox lifecycle/transport and streaming R2 storage have separate services. Existing journals, fences, checkpoint commit ordering and native SDK execution remain authoritative.

Local Alchemy provisions the whole application without production credentials, using a controlled model and a disposable Git remote inside the Sandbox. Native RPC methods in the dev adapter use forwarding functions, because binding an RPC proxy with JavaScript `.bind` produces a `DataCloneError`. The container build context excludes the Worker output, preventing Worker rebuilds from triggering unrelated image rebuilds. The Podman local-runtime patch handles BuildKit-only flags, its Dockerfile stdin limitation and unsupported cgroup-v2 memory swappiness.

The complete local smoke passed on 2026-09-14: API readiness, maintenance hold/release verifying the runner through its service binding, session creation, clone, native model tools, file edit, streamed R2 checkpoint, container destruction/replacement, restored file read and cleanup. No paid provider, GitHub publication or production resource was used. CI now runs that same local Alchemy validation after the project tests.

Regression evidence: the full root suite passed 708 tests with 4 skipped across 127 passing files and 3 skipped files in 615.25 seconds. After the final session service refactoring, all 62 runner tests passed with 2 gated tests skipped in 344.98 seconds. The 12 bridge tests pass. The deployment bundle also built from the locally verified immutable image provenance. Final runner type checking and the production release build passed. `vp check --fix` passed with zero errors and 885 warnings.

The [Worker decision](../../docs/adr/0001-runner-worker-and-linux-workspace.md) explicitly distinguishes preserving existing namespaces and Workerd packaging from a Cloudflare requirement. Production rollout remains the existing reviewed main-branch CI deployment. This branch has not deployed, replaced or deleted live resources; CI rollout and retained-session validation happen after merge.

After merging the latest `main` UI update without conflicts, frozen installation and `vp check` passed with zero errors and 886 warnings. The merged web suite passed all 221 tests across 15 files. The final production bundle excludes development/test routes and fixture credentials.
