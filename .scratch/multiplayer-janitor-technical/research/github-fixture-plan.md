# Disposable GitHub App verification

Use only a repository explicitly designated for this fixture. No production repository, merge, force push, or default-branch update is required. Existing GitHub CLI user authentication cannot verify installation-token behavior.

Required inputs: owner/repository, GitHub App ID or client ID, installation ID, and a local private-key file path. Keep key/token values out of chat, artifacts, archives and command arguments. The installation needs Contents write and Pull requests write for the designated repository. A second designated repository is optional for a negative scope check; do not infer permission to modify it.

The fixture will mint a token scoped by repository ID with Contents write and Pull requests write, and a second Contents read token. It will create uniquely named temporary base/work branches from the existing default branch, create one draft PR from work to the temporary base, update that PR branch, simulate a competing push, verify fast-forward protection, and reconcile a deliberately discarded successful push/PR response by querying GitHub before retrying. A read-only token must fail to push. Revoke an installation token and verify rejection, then mint a fresh scoped token and retry a read. Token expiry metadata and refresh policy are recorded; do not wait an hour or pretend revocation is natural expiry.

Git credentials pass through an in-memory credential helper or outbound credential proxy, never remote URLs or repository config. Inspect the saved Git config and checkpoint contents for fixture-token bytes without printing the token. Installation access is repository-scoped; this does not claim GitHub enforces the session branch boundary. The Janitor publication service must check the intended repository ID, branch, session generation and current readiness before each write.

Cleanup closes the draft PR and deletes only the uniquely named fixture branches. GitHub retains the closed PR record; that is an expected reviewable test artifact. Do not delete the repository or App installation. Record PR URL and cleanup outcomes without secrets.
