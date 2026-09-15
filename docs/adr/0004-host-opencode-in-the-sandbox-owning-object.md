# Host OpenCode in the sandbox-owning Durable Object

The renewed sandbox design places Janitor coordination and OpenCode in the same Durable Object that owns the Linux sandbox. Conversation state stays in DO SQLite; focused Effect services delegate filesystem and process operations to supported Sandbox APIs. This removes the second coordinator DO while preserving durable conversation storage and keeping model credentials outside repository execution. Moving OpenCode into Linux would simplify local tool access but would also require consistent recovery of its conversation database.

This supersedes ADR 0002's choice of SQLite repository files and no shell. It does not supersede ADR 0001's separate Worker decision. The Sandbox SDK retains ownership of its lifecycle and alarm handler; application scheduling must compose with that ownership.

Each agent session owns one such DO and its sandbox, with an isolated repository checkout. Inputs run sequentially within a session. Separate threads never share a mutable checkout, even when they concern the same repository; this avoids cross-thread file interference at the cost of separate container resources.

Cutover removes all existing Janitor sessions and their execution state, and starts fresh sessions. The user accepts losing that session history and unpublished workspace state to avoid a compatibility migration. Published GitHub work is outside this cleanup. The cutover must fence delayed work for retired sessions so it cannot recreate them. This decision authorizes the eventual cleanup, not deletion during the design interview.
