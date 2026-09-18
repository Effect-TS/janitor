# 07: Produce validated bug reproductions in dry-run

**What to build:** A dry-run can install public dependencies, execute a minimal reproduction, and show validated proposed test changes and evidence in the frontend without writing to GitHub.

**Blocked by:** 06: Complete an evidence-based review in dry-run.

**Status:** ready-for-agent

**Design context:** Use the confirmed GitHub-invoked issue review specification and backend design, the domain glossary, and ADR 0009, 0012. This ticket is one slice of the approved design; production review enablement waits for ticket 13.

- [ ] Use a sandbox image with Node.js, pnpm, and common system tools, with outbound internet for public packages and tests. Keep GitHub, model, Slack, and other application credentials outside; no dependency broker or manual test-path setup.
- [ ] Discover and follow the repository's existing test layout. Permit only tests and necessary test-only helpers/fixtures; prohibit production fixes, dependency manifests/lockfiles, build configuration, and workflow changes.
- [ ] Trusted validation compares the patch to the recorded base, canonicalizes paths, rejects traversal, symlink/submodule and binary changes, and bounds patch size/file count. Fail with an explanation when scope cannot be established.
- [ ] Confirm reproduction only when a relevant minimal test executes and fails for the reported behavior. Preserve command, exit result, relevant output, and rationale; setup/dependency/fixture failure is inconclusive.
- [ ] Distinguish not reproduced from inconclusive, explain attempts, and never infer absence of the bug from either result. Installation and tests share the existing 15-minute deadline.
- [ ] Confirm fixed only with a relevant failing test on an affected revision and a passing test on the recorded default-branch commit; otherwise use appears fixed with the unverified parts stated.
- [ ] Suppress redundant reproduction proposals only with evidence of the same behavior under materially equivalent conditions and an existing issue tracking the unresolved problem or adequate reproduction. Link and explain; similarity or a closed issue alone is insufficient.
- [ ] Persist the bounded validated patch, base commit, evidence, and generated findings outside the ephemeral sandbox. Expose them in frontend history; no GitHub or Slack writes.
- [ ] Verify genuine failure, passing/non-reproducing behavior, broken setup, forbidden patches, duplicate suppression, confirmed-versus-apparent fix, timeout, and workspace loss.

## Comments

2026-09-17: Implemented. The sandbox image includes Node 24, pnpm 11.20.0, Python, make and g++; review containers retain internet access and receive no application credentials. The agent can propose complete test files, run setup and test commands, and assess recorded evidence. Trusted validation reads the recorded tree and original blobs from GitHub, discovers existing test conventions, rejects prohibited paths and file kinds, and limits proposals to 20 files and 128,000 diff bytes. Unsupported layouts fail with an explanation.

Migration `0045_issue_review_reproduction.sql` saves the patch, base commit, execution attempts and assessment on the run. Attempts are saved before execution, so deadline expiry or workspace loss retains the command and an inconclusive limitation. History displays the patch, commands, exit results, output, rationale and duplicate links. Historical comparisons restore the default revision before further inspection. No GitHub or Slack writes were added.

Validation: `vp check` passes with warnings. The full suite passed 668 tests across 121 files; focused regression tests subsequently covered the review fixes. Standards review found a duplicated outcome schema, now shared. Spec review found suite-load failures accepted as assertions, untracked execution inputs, cancellation leaving processes running, and restarted actions reusing artifact identities. Those cases now have regression coverage and fixes. Named Jest matcher failures are also recognized without accepting generic suite failures. The Cloudflare container path was typechecked but not deployed locally.
