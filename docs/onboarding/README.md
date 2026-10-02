# Onboarding

Start here if you're new to Janitor. These docs are written so a coding agent can do most of the work. Open the repo in your agent and tell it:

> Read docs/onboarding/README.md and onboard me.

The agent runs the commands and checks the results. It stops when it needs something only you can do, like requesting access or typing a secret into a prompt.

## For the agent

Work through these in order. Don't move to the next step until the current one verifies.

1. [setup.md](setup.md) gets a machine from a fresh clone to a running Janitor that receives real GitHub webhooks.
2. [tour.md](tour.md) explains where things live and the conventions the codebase expects. Read it before you change any code.
3. [troubleshooting.md](troubleshooting.md) lists the failures we've already hit and how to fix them. Check it before debugging something from scratch.

Ground rules while onboarding someone:

- Never ask the developer to paste a secret into the chat. Infisical credentials go straight into the `alchemy profile` prompt, which they type themselves. Anything else secret lives in Infisical and stays there.
- Never deploy. Onboarding touches only the local machine. `vp run deploy:prod` and `alchemy deploy` are out of scope.
- Leave other worktrees and their processes alone. If one is in the way, say so and let the developer decide.
- When a step fails, read the logs under `.alchemy/log/` before guessing.

## Access to request first

Setup blocks on these without them. Ask a Janitor maintainer for:

1. An Infisical machine identity with read access to project `janitor`, environment `development`. You get a universal-auth client ID and client secret.
2. Write access to [`Effect-TS/janitor-sandbox`](https://github.com/Effect-TS/janitor-sandbox), so you can open test issues and pull requests.

You don't need Cloudflare or production access to develop. The shared webhook tunnel already exists and its token comes from Infisical.

## What done looks like

- `vp run check:all` passes.
- `vp run dev` plans with no failures and the website loads at http://localhost:1337.
- The Connect page lists `Effect-TS/janitor-sandbox` and nothing else.
- An issue you open in the sandbox shows up in your local database within a few seconds.
