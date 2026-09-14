# Runner integration progress

Worktree: `/home/maxwellbrown/.t3/worktrees/janitor/runner-project-integration`

Branch: `feat/runner-project-integration`

Base: `7c32b3a`, main after Slack acknowledgement/delivery PR #37.

## Started: dependency and runtime compatibility

Installed root and runner dependencies independently. Retained the approved integration plan in this worktree. No infrastructure or production resources have been changed.

Run the preliminary dependency probe from the worktree root:

```sh
node .scratch/runner-production-integration/probes/effect-graphs.mjs
```

The recorded result is in `probes/effect-graphs.json`. Both dependency graphs report Effect 4.0.0-rc.112, but resolve to distinct modules: the root commit-pinned snapshot and the runner registry release. All four basic service/Layer checks passed, including execution across the two graphs in both directions.

This narrows the earlier assumption: distinct installations are not evidence that every operation is incompatible. The probe does not establish that sharing those graphs is supported for production. Keep current isolation until native host, cancellation, streaming, Alchemy resource binding and checkpoint lifecycle checks pass.

## Next experiment

Use the existing native HTTP/runner test seams to compare the current bundle with one explicitly resolving Effect to the root graph. Keep the candidate resolution confined to the probe. Exercise native model streaming, tools and compaction, then streamed R2 checkpoint restore and Sandbox restart with the intended Alchemy runtime binding. Compare failures against the unchanged baseline before changing package overrides or production composition.

If native compatibility passes, implement one Alchemy-backed checkpoint-store adapter as the first infrastructure slice. If it fails, record the actual failing operation and determine whether supported version alignment fixes it. Do not infer a need for another deployed service merely from package paths.

## Baseline validation

Runner type checking passed. The unchanged native HTTP model driver passed with controlled responses, exercising streaming, tools, usage and local compaction. Its paid-provider case remained skipped. This establishes the baseline to compare against the candidate dependency composition; it is not an Alchemy runtime compatibility result.
