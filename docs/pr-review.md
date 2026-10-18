# Operating PR review

PR review has an AI agent review pull requests in connected public repositories. Each run checks out the pull request's head in a fresh sandbox, reviews the diff against the repository's standards, and posts at most one GitHub review: `REQUEST_CHANGES`, `APPROVE` or `COMMENT`. Janitor keeps a `janitor/review` check run on every head it reviews, and the repository's **PR reviews** page lists every run.

PR review is off until both switches are on. The deployment needs `PR_REVIEW_AI_API_URL` and `PR_REVIEW_AI_API_KEY`, and each repository needs PR review enabled on its Settings page. Enabling it makes reviews live. There is no dry run.

## What it does

### Triggers

A run starts automatically when a non-draft pull request from a human author is opened, reopened, marked ready for review, or pushed to. Bot authors are skipped. The repository must be public, connected, not paused, and have current GitHub access. Fork pull requests and outside contributors are reviewed like members' pull requests.

Each pull request has at most one active run. A push cancels the active run and reviews the new head. Closing the pull request or converting it to a draft cancels the active run. After a run finishes, the next one waits out a two-minute cooldown, and only the newest queued head runs.

### `/janitor`

A top-level comment containing `/janitor` re-runs the review at the current head. Only a human with write or admin permission on the repository can invoke it. Janitor checks the commenter's effective permission when the comment arrives, and a failed lookup denies the request. Edited comments never invoke, and `/janitor` inside quotes, code, or a link destination doesn't count.

Text after the command is invoker guidance for that one run, for example:

```text
/janitor focus on the retry logic in src/client.ts
```

Guidance can narrow or emphasise the review. It can't relax janitor's protocol or approval gates.

A `/janitor` re-run also resets the pull request's automatic run count. On an oversized pull request, `/janitor` forces a review. A forced review can post findings but never approves.

### Limits

| Limit                                                         | Default                                             | Setting                                                      |
| ------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------ |
| Run deadline, counted from the first start and across resumes | 15 minutes                                          | `PR_REVIEW_RUN_DEADLINE_SECONDS`                             |
| Agent told to wrap up                                         | at 10 minutes                                       | `PR_REVIEW_WRAP_UP_AFTER_SECONDS`                            |
| One `bash` command or `execute` script                        | 5 minutes                                           | `PR_REVIEW_COMMAND_TIMEOUT_SECONDS`                          |
| Oversized pull request                                        | more than 10,000 changed lines or 100 changed files | `PR_REVIEW_MAX_CHANGED_LINES`, `PR_REVIEW_MAX_CHANGED_FILES` |
| Inline comments per review, the rest go in the body           | 25                                                  | `PR_REVIEW_MAX_INLINE_COMMENTS`                              |
| Automatic runs per pull request before `/janitor` is needed   | 10                                                  | `PR_REVIEW_MAX_AUTOMATIC_RUNS`                               |
| Resumes after a restart or lost sandbox                       | 3                                                   | `PR_REVIEW_MAX_RESUMES`                                      |
| A finished run's transcript and debugging data kept           | 14 days                                             | `PR_REVIEW_RUN_RETENTION_DAYS`                               |
| Per-pull-request scheduler state kept after close             | 30 days                                             | `PR_REVIEW_SCHEDULER_WIPE_DAYS`                              |

The size count leaves out lockfiles, files the base branch's `.gitattributes` marks `linguist-generated`, and `.changeset/*`. An oversized pull request's automatic runs are skipped, and so are automatic runs past the cap. Both get a `skipped` row and a neutral check run that says why.

### Verdicts

- `REQUEST_CHANGES` when any blocking finding stands.
- `APPROVE` when no blocking finding stands and every approval gate passes. An approval has no body; any nits stay inline. It replaces janitor's earlier `REQUEST_CHANGES` on GitHub, so janitor doesn't dismiss those.
- `COMMENT` when there are only nits, or no blocking findings but a gate failed.

A run with nothing new to say posts no review and only updates the check run. A run that ends before the agent finishes, at the deadline or after a provider failure, posts a partial review from the findings it already has. A partial review never approves.

Only janitor's `CHANGES_REQUESTED` reviews after its latest `APPROVED` or `DISMISSED` review count as outstanding (`earlierChangesRequested` at publish time). `COMMENTED` and `PENDING` reviews do not change that cutoff. A dismissed review supersedes earlier change requests without counting as approval, even when it was a stale approval dismissed after a push. Newer change requests remain outstanding.

The approval gates are checked in trusted code at publish time:

- the head and base are unchanged since the run started;
- the run finished on its own, without being told to wrap up;
- no blocking finding stands that isn't cleared for approval;
- the pull request is open and not a draft;
- the run wasn't a forced review of an oversized pull request;
- an author without write access didn't touch a sensitive path (`PR_REVIEW_SENSITIVE_PATHS`, default `.github/**`, `AGENTS.md` and `.agents/**`, plus dependency changes in `PR_REVIEW_LOCKFILES` and `PR_REVIEW_MANIFESTS`).

Janitor doesn't read CI before approving. Its approval means the review has no outstanding concern, not that the pull request can be merged. Required status checks still guard the merge button.

### The `janitor/review` check run

| State                                                                                                | Meaning                                                                                           |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `in_progress`, "Reviewing"                                                                           | A run is reviewing this head.                                                                     |
| `failure`, "N blocking findings"                                                                     | Blocking findings stand. The summary links each thread.                                           |
| `success`, "No blocking findings"                                                                    | Nothing blocks. If a gate failed, the title says "not approved" and the summary gives the reason. |
| `cancelled`, "Review cancelled"                                                                      | A newer push, closing, converting to a draft, or disabling PR review stopped the run.             |
| `neutral`, "Skipped: too large"                                                                      | The pull request is oversized. `/janitor` reviews it anyway.                                      |
| `neutral`, "Skipped: automatic reviews paused"                                                       | The automatic run cap was reached. `/janitor` re-runs.                                            |
| `neutral`, "Incomplete review"                                                                       | The run ended early and posted a partial review.                                                  |
| `neutral`, "Checkout failed", "No sandbox available", "Review stopped" or "Couldn't post the review" | The run errored. See [Troubleshooting](#troubleshooting).                                         |

The summary also lists janitor's earlier `REQUEST_CHANGES` reviews it couldn't dismiss.

### Disputing a finding

Reply in the finding's thread. The next run reads the thread and judges each earlier finding `still_applies`, `addressed` or `withdrawn`. It resolves an `addressed` thread without a reply, and replies in the others when it has something new to say.

The author's own reply or resolution lifts `REQUEST_CHANGES`, but it never clears a blocking finding for approval. Approval needs either the agent to judge the finding `addressed` or `withdrawn`, or a reply or resolution from a human with write access other than the author. A maintainer can also comment `/janitor` to re-run, or dismiss janitor's review on GitHub.

## Per-repository setup

1. Open the repository's Settings page in janitor and select **Enable** under **PR review**. Janitor refuses to enable a private repository, or one whose visibility it hasn't seen yet. Any teammate can enable or disable it. Disabling cancels the repository's running reviews straight away.
2. On each protected branch, add janitor to the list of people and apps allowed to dismiss pull request reviews. Without it, janitor can't dismiss its own `REQUEST_CHANGES` once nothing blocks but a gate still withholds approval, and the check run lists the review it couldn't dismiss.
3. Turn on **Dismiss stale pull request approvals when new commits are pushed**. This is required. Janitor doesn't dismiss its own approval after a push. It relies on GitHub, and re-approves on the next run when the gates pass.
4. Making `janitor/review` a required status check is optional. Required checks treat `neutral` as passing, so oversized, deadline-hit and errored runs don't block the merge.
5. Janitor's approval counts toward required approvals. To keep it advisory, require two approvals, or require review from code owners. An App can't be a code owner, so a human always has to approve.

The agent reviews against these standards, read at the pull request's base branch:

- janitor's default rubric;
- `AGENTS.md`;
- skills under `.agents/skills`;
- `.github/janitor/review.md`.

Repository standards add to the rubric and win where they conflict with it. They can't override janitor's protocol. Each run's record stores which sources applied, though the PR reviews page doesn't show them yet.

## Deployment setup

### GitHub App

PR review needs these App permissions:

| Permission    | Access |
| ------------- | ------ |
| Pull requests | write  |
| Checks        | write  |
| Contents      | read   |
| Issues        | read   |
| Metadata      | read   |

PR review must not hold `contents: write`. Labeling separately needs `issues: write` to apply labels, so the production App keeps that. Subscribe to the `pull_request` and `issue_comment` webhook events. Changing permissions sends every installation a request to accept them, and until an installation accepts, janitor runs with the old permissions there.

The development App, `effect-janitor-development`, holds `contents: write` and only `checks: read`, so it can't write `janitor/review` check runs.

### Model and spending cap

The agent calls an OpenAI-compatible chat completions endpoint. Set `PR_REVIEW_AI_API_URL` to the endpoint's base URL, the part before `/chat/completions` (for example `https://openrouter.ai/api/v1`), and `PR_REVIEW_AI_API_KEY` to its API key, both in Infisical (project `janitor`, environment `production`). Without both, PR review is unavailable in the deployment. Webhooks don't start runs, and the Settings panel says "Unavailable in this deployment". Give the key a credit limit at the provider. That limit is PR review's spending cap. Once it runs out, model calls fail and runs end as incomplete reviews.

| Setting                         | Default                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `PR_REVIEW_AI_MODEL`            | `openai/gpt-6.1-sol`                                                         |
| `PR_REVIEW_AI_REASONING_EFFORT` | `medium` (one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) |

`PR_REVIEW_AI_MODEL` is the model name as the endpoint expects it. The effort is sent as `reasoning_effort`, so the endpoint must accept that value for the model.

The Settings panel shows the model and effort the deployment runs with.

### A private endpoint on the tailnet

An endpoint that is only on the Tailscale tailnet, such as the CLI proxy at `https://cliproxy.service.prod.ops.effectful.co/v1`, is reached through the tailnet egress. That's a small container (`apps/cluster/containers/tailnet-egress`) that joins the tailnet as an ephemeral node and forwards the model's requests to the origin of `PR_REVIEW_AI_API_URL`, and nowhere else. One container serves every run. It starts on the first model call, takes a few seconds to join, and stops after 15 idle minutes. The sandbox never sees the Tailscale credential.

| Setting                    | Default            | Meaning                                                                                                   |
| -------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------- |
| `PR_REVIEW_AI_VIA_TAILNET` | `false`            | Send model calls through the tailnet egress instead of the open internet                                  |
| `TAILSCALE_AUTH_KEY`       | none               | A Tailscale OAuth client secret with only the Auth Keys write scope and only the tags in `TAILSCALE_TAGS` |
| `TAILSCALE_TAGS`           | `tag:janitor-prod` | The tags the egress node joins with; the tailnet policy grants these the endpoint                         |

The container reads `TAILSCALE_AUTH_KEY`, `TAILSCALE_TAGS` and `PR_REVIEW_AI_API_URL` when it deploys, so changing any of them needs a deploy. To switch to a tailnet endpoint, deploy with `TAILSCALE_AUTH_KEY` set, then set `PR_REVIEW_AI_API_URL`, `PR_REVIEW_AI_API_KEY`, `PR_REVIEW_AI_MODEL` and `PR_REVIEW_AI_VIA_TAILNET=true` together and deploy again. To switch back, restore the previous endpoint settings, set `PR_REVIEW_AI_VIA_TAILNET=false` and deploy.

### Limits and sandbox capacity

The limit settings in [Limits](#limits) are optional and deployment-wide. `PR_REVIEW_WRAP_UP_AFTER_SECONDS` must be less than the deadline, and the command timeout must fit in the time between wrap-up and the deadline. An invalid combination fails the review model's calls, not labeling.

`PR_REVIEW_SANDBOX_MAX_INSTANCES` (default 20) sets the container application's `max_instances`. It caps how many runs can hold a sandbox at once. It's read at deploy time, so a change needs a deploy. A run that can't get a container keeps retrying until its deadline.

## Accepted risks and limits

- Prompt injection in a pull request, especially from an outside author, can get a clean review, and no gate in trusted code can tell.
- The agent installs dependencies and runs tests and scripts. Code from the pull request, or a dependency it pulls in, runs next to the agent and can fake what the agent sees. The sandbox holds no credentials and is destroyed after the run, so this threatens the review's integrity, not janitor's secrets.
- Sandboxes have outbound internet. Compute and egress abuse are bounded by the run limits and `max_instances`.
- On a repository without stale-approval dismissal, an outside author can push after janitor approves and keep the approval until a later run requests changes. If that run fails a gate, it posts no review and the approval stands.
- Janitor's approval isn't advisory unless the repository makes it so (two approvals or code owners).
- Private repositories are out of scope. If a repository goes private mid-run, the checkout or a later step fails and the run posts nothing.

## Monitoring

- **PR reviews page:** each repository's runs, newest first, with outcome, blocker and nit counts, failed gates, trigger, timing, and links to the review and check run. Running and skipped runs appear too.
- **Transcripts:** every run except a skipped one links to its transcript, the agent session as the run committed it. It shows each prompt message in order (the system prompt isn't stored), with tool calls and results collapsed, plus every finding and thread judgement the agent recorded, whether the run resumed, was told to wrap up or hit its deadline, and when the transcript goes. A running run shows the steps it has finished so far. **Download JSON** saves the same data, which `GET /api/v1/repositories/:repositoryId/pull-request-review/runs/:runId/transcript` serves.
  - A transcript lives only in the run's own storage, so it lasts as long as `PR_REVIEW_RUN_RETENTION_DAYS` after the run ends, and a cancelled run's goes at once. After that the page says it's no longer kept and the endpoint answers `410`. There is no other copy. A repository that goes private keeps its transcripts until they expire.
  - Messages over the 2 MB row limit are stored with placeholders, so an image or a huge tool result may show as `[image omitted, re-read the file if needed]`.
  - Anyone with Access can read a transcript, as with the rest of the app. It holds the diff, repository files, sandbox command output, earlier review comments with GitHub logins, and `/janitor` guidance, all from public repositories. The pull request controls much of it, so the page shows every message as plain text, never as HTML or Markdown. A reasoning block is the model's working, not the review's conclusion.
- **Check runs:** `janitor/review` on each pull request is the canonical state of its review.
- **Logs:** Worker logs in Cloudflare observability. PR review logs carry `runId`, `repositoryId`, `number` (the pull request) and `headSha` where they apply, so filtering on one run's id shows its whole history. They never include provider error bodies, pull request content or tokens: an error logs only its category (`error`), and the `operation` and `status` when it has them.
- **Model spend:** the key's usage and remaining credit at the provider. A key near its limit will start failing runs.

The log messages that mark a run's progress:

| Message                                                                                 | When                                                                                                                   |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `Admitted PR review event`                                                              | A webhook passed admission. `outcome` says what happened to it, such as `scheduled`, `oversized`, `rerun` or `denied`. |
| `PR review run scheduled`                                                               | The per-pull-request scheduler started a run, with its `trigger`.                                                      |
| `PR review run waiting for the cooldown`, `PR review run dropped: PR review is off`     | The scheduler held or dropped a queued head.                                                                           |
| `PR review run started`                                                                 | The run wrote its start row and check run, and is getting a sandbox.                                                   |
| `PR review run resuming`, `PR review sandbox lost; resuming in a new one`               | The run restarted or lost its sandbox. `resumeCount` counts toward `PR_REVIEW_MAX_RESUMES`.                            |
| `PR review run told to wrap up`, `PR review run hit its deadline`                       | The run reached minute 7 or minute 10.                                                                                 |
| `PR review run publishing`                                                              | The agent finished, with `unfinished` set when it didn't complete.                                                     |
| `PR review run published`                                                               | The review went out, with `status`, `verdict` and `failedGates`.                                                       |
| `PR review run skipped`, `PR review run cancelled`, `PR review run failed`              | The run ended without a review. A failed run has an `errorCategory`.                                                   |
| `PR review scheduler will wipe itself after the close`, `Wiped the PR review scheduler` | A closed pull request's scheduler state is going, or gone.                                                             |
| `Tailnet egress started`, `The tailnet egress did not start: <reason>`                  | The tailnet egress container joined the tailnet, or didn't.                                                            |
| `The tailnet egress container did not answer (...)`                                     | A started container's port rejected a request; the message gives workerd's error.                                      |

## Troubleshooting

### Checkout failed

The sandbox couldn't fetch the pull request head or base. Janitor retries before giving up, and the check run then says "Checkout failed". Check that the repository is still public and connected with current access, and that the head SHA still exists. A force-push that removed it is fine, because the new head gets its own run. Comment `/janitor` to retry.

### Dismissal 403

GitHub refused to dismiss janitor's earlier `REQUEST_CHANGES` review, and the check run lists the review under "Couldn't dismiss janitor's earlier review". Add janitor to the protected branch's dismissal allow-list (step 2 of [Per-repository setup](#per-repository-setup)). Until then a maintainer can dismiss the review by hand.

### Resume limit

The run lost its sandbox or restarted more than `PR_REVIEW_MAX_RESUMES` times, and the check run says "Review stopped". Repeated losses usually point at container capacity or the container crashing on the pull request's workload. Look for sandbox lost and container warnings in the logs, then comment `/janitor` to start a new run.

### Container start failures

No container started before the deadline, and the check run says "No sandbox available". All `max_instances` sandboxes may be busy, or Cloudflare may be failing to start the image. Look for "No PR review sandbox container available" and "Sandbox container request failed" in the logs. Raise `PR_REVIEW_SANDBOX_MAX_INSTANCES` and deploy if the cap is the cause.

If the run failed within seconds and the logs say "PR review sandbox has no container application", the workspace Durable Object namespace has no container application attached. A deploy that failed partway leaves it like this: alchemy pre-creates the container application, then fails with "has an unresolved Durable Object namespace and no recorded attachment" before the Worker creates the namespace. Every run fails this way until a deploy succeeds. Re-run the Deploy workflow, then check that the container application lists the namespace under `durable_objects`.

### Provider errors

The check run says "Incomplete review" and "the review stopped on a provider error", and the logs say "The PR review model failed", with the error category and the endpoint's HTTP status. `InternalProviderError` is a 5xx from the endpoint. HTTP 530 is Cloudflare's own error for a host the Worker can't resolve or reach: check that `PR_REVIEW_AI_API_URL` resolves in public DNS, or set `PR_REVIEW_AI_VIA_TAILNET` if it's a tailnet endpoint. With the tailnet egress, HTTP 503 means the egress container didn't start or didn't answer, and the logs say "The tailnet egress did not start" or "The tailnet egress container did not answer", with the reason. HTTP 502 means it started but couldn't reach the endpoint: check the tailnet policy grants `TAILSCALE_TAGS` the endpoint, and that the endpoint is up. `AuthenticationError` points at `PR_REVIEW_AI_API_KEY`, `QuotaExhaustedError` at the key's credit limit, and `InvalidRequestError` at `PR_REVIEW_AI_MODEL` or `PR_REVIEW_AI_REASONING_EFFORT`.

### Unavailable deployment

The Settings panel says "Unavailable in this deployment" and the **Enable** button is disabled. `PR_REVIEW_AI_API_URL` or `PR_REVIEW_AI_API_KEY` isn't set for the deployed Worker. Set both in Infisical's production environment and deploy. Repositories keep their enable flag while the deployment is unavailable, and they start reviewing again once it's available.
