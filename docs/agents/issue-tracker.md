# Issue tracker: local Markdown

Issues and specs live as Markdown files in `.scratch/`.

## Conventions

- Use one directory per feature: `.scratch/<feature-slug>/`.
- Store the spec in `spec.md`.
- Store each implementation ticket in `issues/<NN>-<slug>.md`, numbered from `01`.
- Record triage state in a `Status:` line near the top of each issue. Use the role strings in `docs/agents/triage-labels.md`.
- Append comments and conversation history under `## Comments`.

## Publishing and fetching

When a skill says to publish to the issue tracker, create the appropriate file under `.scratch/<feature-slug>/`.

When a skill says to fetch a ticket, read the referenced file. Resolve ticket numbers within the relevant feature directory.

## Wayfinding operations

For `/wayfinder`:

- Map: `.scratch/<effort>/map.md`, containing Notes, Decisions-so-far, and Fog.
- Child ticket: `issues/<NN>-<slug>.md`, numbered from `01`, with the question in the body.
- Type: record `research`, `prototype`, `grilling`, or `task` in a `Type:` line.
- Status: wayfinding tickets use `open`, `claimed`, or `resolved`.
- Blocking: record `Blocked by: NN, NN` near the top. A ticket is unblocked when every listed blocker is resolved.
- Frontier: choose the first open, unblocked ticket by number.
- Claim: set `Status: claimed` and save before starting work.
- Resolve: append the answer under `## Answer`, set `Status: resolved`, and append a summary and link to Decisions-so-far in the map.
