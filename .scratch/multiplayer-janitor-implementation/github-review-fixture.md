# GitHub review fixture

Put these variables in `.env.github-review-fixture` at the repository root. The
file is ignored by Git. The generated empty file has owner-only permissions.

```dotenv
FIXTURE_GITHUB_REPOSITORY=owner/disposable-repo
JANITOR_GITHUB_APP_ID=
JANITOR_GITHUB_APP_PRIVATE_KEY_FILE=/absolute/path/to/app-private-key.pem
GITHUB_REVIEWER_TOKEN=
```

Install the App on the named repository with Contents and Pull requests
read/write. Use a separate human account's token with repository access and Pull
requests read/write. The fixture retrieves the reviewer identity from GitHub;
email and login are not identity proof. Do not commit tokens or private keys.

Run from the repository root:

```sh
JANITOR_RUN_GITHUB_REVIEW_FIXTURE=1 vp test apps/cluster/test/GitHub/Feedback.live.test.ts
```

The fixture creates one branch and PR, submits a review with two inline comments,
hydrates the live membership through the production adapter, and admits one
grouped input into local PostgreSQL. It publishes one inline App reply and
reconciles its marker, App identity, PR and discussion root. Cleanup closes the
PR and deletes the branch. Results and cleanup status go to
`github-review-live.json` in this directory.

This checks live GitHub REST behavior. It uses a local session runner stand-in
and does not establish live webhook callbacks, account-link callbacks, deployment,
or model behavior. The controlled native publication suite separately verifies a
GitHub-origin turn editing and publishing on the existing PR branch. No paid
model calls are made.

For deployed conversation-comment intake, set `JANITOR_GITHUB_APP_LOGIN` to the
App's exact bot login, including `[bot]`, and subscribe the App to
`pull_request_review`, `pull_request_review_comment`, and `issue_comment`.
Submitted reviews and inline feedback do not require a mention. Conversation
comments require that configured login.
