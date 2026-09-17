# Defer reviewed CI contracts for issue review

Status: accepted.

The initial issue-review workflow does not require a reviewed per-repository CI contract before publication. Invocations require human repository write or admin permission, and the user chose to defer the proposed CI-contract requirement for this version.

Repository opt-in delegates downstream CI safety to repository administrators. The human invoking Janitor is responsible for the instructions they provide. Janitor does not audit or gate publication on CI configuration in this version. The user reports that their CI is already secured against fork PRs; this is not a verified guarantee about execution from Janitor's same-repository branches.

This revises the earlier requirement for Janitor to enforce fork-equivalent downstream CI protection. Authorized invocation controls who requests work; generated tests still execute under the receiving repository's CI configuration. Janitor cannot promise fork-equivalent restrictions for these branches. The proposed strictness and unknown-safety fallback in interview questions Q16 and Q17 were not accepted.

This decision does not relax Janitor's own sandbox requirements. The zero-secret boundary remains accepted; [ADR 0009](0009-allow-sandbox-internet-for-the-mvp.md) separately replaces restricted egress with outbound internet access for the MVP.

Invoker responsibility does not make issue content, repository code, referenced material, or tool output trustworthy. The instruction and evidence boundary in ADR 0007 remains in effect.
