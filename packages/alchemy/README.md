# Sandbox workspaces

One checkout per session, acquired on the first sandbox operation.

```text
Local session -> HTTP -> Node workspace host -> Git worktree
Deployed session -> Durable Object -> Node container -> Git checkout
```

## Local development

Start the host from the repository root:

```sh
vp run --filter @janitor/alchemy sandbox:dev
```

It listens on `127.0.0.1:4789`. `PORT` and `WORKSPACE_ROOT` override the defaults.
Worktrees live in `.alchemy/workspaces`; shared bare repositories and checkout
records live in sibling `.repos` and `.state` directories. Run one host per root.
Git uses the host's credential helpers unless a `Git/Credentials` service is provided.

Provide a session layer to the code using `Sandbox`:

```ts
import { layerDevSession } from "@janitor/alchemy/AI/SandboxSession"

const workspace = layerDevSession({
  key: "owner/repo#7",
  remote: { url: "https://github.com/owner/repo.git" },
  ref: "refs/pull/7/head",
  url: "http://127.0.0.1:4789",
})
```

The URL also accepts an Effect that resolves a runtime binding. An Alchemy
`Command.Dev` resource can run the command above and supply its `url` output.
`SandboxHttp` addresses every operation by checkout key. The host resolves that
key before executing it, and rejects operations on missing checkouts.

The host executes commands as the local user. File operations enforce workspace
containment; shell commands have the host user's permissions.

## Cloudflare sessions

```ts
import { layerContainerWorkspace } from "@janitor/alchemy/Cloudflare/AI/SandboxSession"

const workspace = layerContainerWorkspace(
  {
    key: "owner/repo#7",
    remote: { url: "https://github.com/owner/repo.git" },
    ref: "refs/pull/7/head",
  },
  { enableInternet: true },
)
```

Build this layer for the owning session and provide the container image runtime
from `Cloudflare/AI/SandboxContainerRuntime`. Calls require the session's
`DurableObjectState`; the caller must route each session to its own Durable Object.
The adapter checks checkout state before each operation, including after a guest
has been replaced.

## Checkout lifecycle

`Git/Checkouts` exposes `checkout`, `get`, and `release`. Implementations are
`CheckoutsWorktree`, `CheckoutsSandbox`, and the development RPC client
`CheckoutsWorkspace`.

- The default ref is `remote.defaultBranch`, or `main`.
- Repeated acquisition preserves local changes. A different ref requires `fresh: true`.
- Branch names, commit IDs, and full refs such as `refs/pull/7/head` are supported.
- Failed acquisition records pending ownership so the next acquisition can retry.
- `fresh` resets tracked files and removes untracked, non-ignored files.
- `SessionWorkspace.checkout` explicitly acquires the session checkout.
- `SessionWorkspace.release` deletes the checkout, including unpublished work.
  Call it when removing a session, not when a request finishes.

Local work survives server restarts. Container storage is ephemeral; checkout
records do not preserve unpublished work if Cloudflare replaces the container.
These adapters do not publish branches or back up disk contents.

## Verification

```sh
vp run --filter @janitor/alchemy typecheck
vp check packages/alchemy
vp test packages/alchemy/test
```

Tests use temporary repositories, real Git processes, and a Node HTTP server.
Building the container image and testing a deployed Cloudflare session require
separate deployment checks.
