# Repository execution fixture

The original `fixture.mjs` establishes a host Git/archive baseline. The additional probes below exercise the pinned OpenCode SDK, Workerd, Cloudflare Sandbox, R2, and the authorized GitHub fixture. All archives use the Janitor-owned tar protocol, not the SDK backup helper.

Run outside the parent workspace because `.scratch` packages are not workspace members:

```sh
fixture_run_dir=$(mktemp -d /tmp/janitor-fixture-run-XXXXXX)
cp .scratch/multiplayer-janitor-technical/prototype/repository-fixture/package.json \
  .scratch/multiplayer-janitor-technical/prototype/repository-fixture/fixture.mjs \
  "$fixture_run_dir/"
cd "$fixture_run_dir"
/home/maxwellbrown/.local/share/vite-plus/bin/vp run verify
```

No dependency installation is needed for the host fixture. Requires Node, Git, and tar. The script creates a new temporary directory for every run, prints its location, and retains it for inspection. All pushes target a generated local bare repository. No credentials or remote repositories are used. Git author identity is confined to generated repositories.

The untouched `workspace` directory contains staged and unstaged changes to the same file, an unpublished commit, staged deletion, untracked feedback, a required ignored file, disposable cache, a symlink, and an executable file. `expected-state.json` captures the baseline. A restored copy exercises local publication and concurrent human commits. `result.json` records assertions and explicit integration-test exclusions.

For the eventual Cloudflare fixture, recreate the same state inside `/workspace`, collect the same manifest through the real OpenCode adapter, checkpoint through the chosen R2 implementation, destroy the sandbox, and compare the restored manifest. Re-run the fixture command after restoration. A passing host archive is not evidence that Cloudflare's production filesystem preserves these properties.

## Additional local probes

The recovery extension adds `vp run recovery`, using Node's built-in SQLite and actual socket disconnects. It verifies same-bridge lost-response retries, rejects old bridge epochs after recreation, reopens committed operation state after child-process exits, and fences checkpoint commits after disconnection. This is local SQLite evidence, not Durable Object crash evidence. Bridge calls now require the instance's `x-bridge-epoch` in addition to authentication. A client must not discover a new epoch and silently resubmit an uncertain old operation.

`probe-containment.mjs` runs in the pinned image using optional per-command user/PID namespaces. It checks a detached child really started, then could not perform a delayed write after its command exited; it also checks forced cancellation before freeze. This mode is experimental and not enabled by default. Its deliberate consequence is that background processes cannot outlive a command. The user accepted this foreground-only MVP restriction; remote namespace support passed in the authorized Cloudflare fixture. This does not verify native OpenCode shell integration. See [containment findings](../../research/process-containment.md).

Recovery probes exposed two details fixed in the bridge: duplicate stdin requests now wait for the original write's result instead of immediately claiming success, and sending empty EOF to a command that has already closed input does not fail a completed no-input operation. Actual nonempty write errors remain errors. OpenCode default file operations were rebuilt and rerun with task caching disabled after these changes.

Copy all `.mjs` files and `package.json` into the isolated directory to run `vp run bridge` and `vp run checkpoint`. The first exercises an authenticated loopback HTTP process bridge; the second uses an in-memory bucket to test archive integrity and checkpoint-pointer ordering. These have explicit limits in their output. The bridge is a bounded experiment with in-memory operation records and an 8 MiB output cap, not a production process supervisor. The archive extractor only handles this generated fixture and is not hardened for arbitrary repository archives.

`probe-opencode.mjs` uses the pinned OpenCode `execDefaults` with a narrow Effect process adapter over that bridge. It ran in the existing `/tmp/janitor-workerd-probe/tools/workerd-probe` dependency graph using `bundle-opencode.mjs`, followed by the generated Node bundle. Added isolated probe scripts were `repository-bundle` and `repository-files`. This verified actual OpenCode file operations in Node, not Workerd, full process options, or runner recovery. The narrow adapter rejects unsupported pipelines and additional fds; the bridge accepts its configured workspace and canonical subdirectories; it is not the production adapter.

## Disposable Cloudflare bundle

`worker.ts`, `wrangler.jsonc`, `Dockerfile`, `bridge.mjs`, `probe-bridge.mjs`, `probe-containment.mjs`, and `remote-package.json` form a separate Cloudflare smoke fixture. Copy them into a fresh directory, rename `remote-package.json` to `package.json`, and run `vp install` and `vp run bundle`. Preserve the generated dependency lockfile for the run. The SDK and image are pinned to 0.12.9, including the image digest; Wrangler is pinned to 4.131.1.

The only callable operation is authenticated `POST /verify`. It runs the bridge probe inside a sandbox, writes a tiny Git workspace, saves its custom tar archive through the R2 binding, destroys the original sandbox, restores into a new sandbox, and compares Git state. It does not invoke models or access GitHub. It does not claim a full OpenCode adapter or durable pointer/recovery proof. All fixture commands are fixed in source.

Before deployment, select the Cloudflare account and unique Worker/bucket names, create the dedicated R2 bucket, and set `FIXTURE_TOKEN` as a Worker secret. Do not put the token in source or logs. With remote authorization, use `vp run cloudflare r2 bucket create <name>`, `vp run cloudflare secret put FIXTURE_TOKEN`, and `vp run deploy`. Send exactly one authenticated request; retain its returned fixture ID and result. Stop after the first run to assess evidence. Per-command timeouts are 30 seconds where set; those are not a platform spending cap or proof that a timed-out process stopped.

The config limits the application to two instances. Each run uses an original and restored sandbox sequentially and one small R2 archive. Cleanup attempts run in `finally`, but a killed request or cleanup error may leave resources behind. After the experiment, verify container termination and bucket emptiness, delete remaining fixture objects, then delete the dedicated bucket and Worker using `vp run cloudflare r2 bucket delete <name>` and `vp run cloudflare delete --name <name>`. Verify associated container/DO resource removal using the selected account; do not delete any existing Janitor resources. Deployment must not proceed until the account, isolated names, usage authorization, and cleanup ownership are established.

## Workerd file adapter probe

The spawner is extracted into `fixture-spawner.mjs`. Copy it with `worker-opencode.mjs`, `bundle-workerd-files.mjs`, `probe-workerd-files.mjs`, and `bridge.mjs` into the existing pinned OpenCode probe package. Define `files-workerd-bundle` as `node bundle-workerd-files.mjs` and `files-workerd` as `node probe-workerd-files.mjs`, then run both through `vp run --no-cache`. This uses Miniflare 4.20260708.0 and the pinned Effect graph. It tests actual OpenCode default file operations in Workerd against an external host bridge. Native shell, complete process options, and the full session/provider lifecycle remain unverified.

## Native shell extension

Include `native-shell.mjs` and `native-tool.mjs` when copying the Workerd probe files. The Workerd file probe now also builds the actual pinned Shell service with fixture dependencies and checks output capture, nonzero exit, timeout, and cancellation through removal followed by bridge freeze. It demonstrates the inaccessible Workerd-local full-output path, then copies 100,000 captured bytes into the external workspace and compares them. This local service probe also exercises the native ShellTool with fixture services. The combined Cloudflare fixture additionally runs the full SDK session and durable completion ordering. See `research/native-shell-workerd-result.json` relative to the technical effort for the captured result.

## Combined Cloudflare contract and GitHub probes

`contract-worker.mjs` exports the Sandbox and Contract Durable Objects. `sdk-session.mjs` runs a real SDK session with a deterministic fake model, native shell tool, foreground rejection, and capture persistence. `remote-bridge-server.mjs` exposes a private container port through Sandbox RPC; it contains deliberate response-loss injection and fixed archive endpoints. `workspace-manifest.mjs` compares the complete generated worktree and local Git state. These are disposable test components, not production endpoints.

Build the Workerd bundle in the pinned OpenCode probe dependency graph using `bundle-contract.mjs`. Set `SANDBOX_SDK_ENTRY` to the absolute path of the installed Sandbox 0.12.9 `dist/index.js` when using a different temporary directory. Add a `contract-bundle` script running `node bundle-contract.mjs`, and invoke `vp run --no-cache contract-bundle`. The sample `wrangler.contract.jsonc` needs unique names, an account, the dedicated R2 bucket, and the built image. Podman requires the documented manual build/tag/registry push followed by deployment using the registry image.

The isolated remote package needs these scripts, run through `vp run --no-cache`:

- `contract`: `node probe-contract.mjs`. Requires `FIXTURE_URL`, `FIXTURE_SECRET_FILE`, and a fresh `FIXTURE_INSTANCE`. Uses real SQL, R2, container destruction, and DO aborts. A fixture identity is retired after `/cleanup`; do not reuse it.
- `github`: `node probe-github.mjs`. Requires `FIXTURE_APP_ENV_FILE`. Uses only the explicitly authorized Effect-TS/slopcop-sandbox repository. Creates temporary branches and a draft PR, then removes the branches and closes the PR. PR records remain.
- `github-cloudflare`: `node probe-github-cloudflare.mjs`. Requires the App environment-file path and the remote fixture URL/secret-file path. Uses a fresh fixture identity, passes only a scoped installation token to the fixed Cloudflare Git command, removes the branch and container workspace, and revokes the token.
- `branch-protection`: `node probe-branch-protection.mjs`. Supplemental check using the successful GitHub fixture checkout. It attempts a temporary protection rule on its uniquely named test branch, never the default branch. The designated private repository's current plan rejected enabling protection; the generated branch was removed. The required no-write case was separately exercised using a scoped read-only installation token.

Do not print or copy App private keys or installation tokens. The App environment file stays local. Only a short-lived repository-scoped token enters the Cloudflare Git fixture, in a temporary command environment.

Remove fixture objects and sandbox instances first, then delete the Worker, both DO namespaces, container application, dedicated R2 bucket and all uploaded fixture image tags. Worker deletion alone does not remove the container application. Verify resource-specific absence and remove the local fixture-secret file. Preserve result JSON and commands, not credentials.
