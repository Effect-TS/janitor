# Require explicit authorization for GitHub issue review

Status: accepted.

Issue review starts or resumes only through an explicit GitHub invocation by someone with sufficient repository permissions, in a repository that has opted in. Issue creation, edits, and ordinary comments cannot initiate or continue work. This gives repository operators control over execution at the cost of requiring another invocation after a reporter supplies missing information.

Initial invocation accepts a free-form request containing a standalone `/janitor` command anywhere outside quoted text, code, or link destinations in a newly created comment on an open issue. No fixed `review` command or first-line command grammar is required. Issue bodies, edited comments, quoted invocations, PR comments, and closed issues are excluded. A comment without the command cannot start or resume work.

The `/janitor` command replaces the former user mention syntax so invoking review does not notify an unrelated GitHub account. New comments using the old syntax are ignored. Commands embedded in URL paths or longer command names are not invocations.

Human invokers need effective repository write or admin permission, including custom roles with that base access. No additional Janitor operator allowlist is required. Permission lookup failures deny execution. Janitor and other GitHub bot or App identities cannot invoke review; an ordinary user account used for automation remains a limitation of account-type checks.

Free-form input may guide investigation through symptoms, hypotheses, relevant files, and proposed reproduction steps. It cannot override the workflow's repository, sandbox restrictions, publication rules, or prohibition on fixes. Authorization permits requesting work; it does not make issue bodies, comments, PR content, repository files, or tool output trustworthy. Quoted text, code blocks, linked pages, and referenced comments remain evidence and cannot inherit the invoker's authority. Operator-supplied commands also execute only inside the sandbox. Trusted application code outside the model must enforce the limits; separating instructions and evidence in model input does not itself enforce them.

Check current invoker permission at admission, before execution, and before each external write. A failed check or detected revocation stops further work and blocks publication; completed writes remain. These checks cannot eliminate the race between a GitHub permission check and an external write.

Accepted instructions are an immutable snapshot. An edit cannot change an active run or start another run. Detecting an edit or deletion stops the affected run and prevents further publication; replacement instructions require a newly posted invocation. This avoids attributing another person's edits to the original author. The confirmed backend design records edit/deletion detection and publication ordering.

Each invocation supplies the current instructions. Prior findings, attempts, and conversations remain evidence; previous instructions do not automatically remain binding. Each run fetches current GitHub evidence and records the default-branch commit it uses.

Only one run may be active per issue. Later invocations queue in order and undergo fresh authorization checks before starting. Redelivery of the same GitHub comment cannot create another run; separately posted invocations remain distinct even when their text is identical. This preserves explicit requests while preventing competing summary updates and reproduction publications.

The frontend provides a Cancel run action to users whose current GitHub permission meets the invocation threshold. It stops the selected active or queued run without cancelling other queued requests. Completed publications remain intact. Editing or deleting an invocation still stops its own run.

Detecting repository pause, disconnection, lost GitHub access, or disabled issue review stops the active run and cancels queued runs. Restoring eligibility never revives old work; new invocations are required. Completed GitHub publications remain.

Closing an issue stops its active run, cancels queued invocations, and blocks publication of saved results while closed. Reopening does not restart work; a new invocation is required. Existing comments and PRs remain untouched.

Enabling dry-run blocks further automatic GitHub writes, while investigation may finish in the frontend. Disabling dry-run never upgrades an existing dry-run into a publishing run. [ADR 0011](0011-explicit-publication-of-dry-run-results.md) permits a separately authorized frontend action to publish one saved result while dry-run stays enabled. Publication ordering must account for configuration changes and external writes already in flight. Slack integration is outside the MVP.

This workflow does not inherit the conversational continuation or accepted-input authority rules of Slack sessions in ADR 0005. [ADR 0010](0010-model-issue-review-as-an-effect-workflow.md) records the publication recovery model. The confirmed [backend design](../../.scratch/github-issue-review/backend-design.md) records enforcement mechanics.
