# Store agent workspaces in the session Durable Object

Janitor runs OpenCode through its Workerd SDK in each session Durable Object and stores repository files, edits and tool receipts in the same SQLite database. Repository reads and publication use GitHub APIs. This replaces the Linux workspace decision in ADR 0001 and removes container startup, process bridges and filesystem checkpoint coordination.

The agent has controlled repository tools rather than a shell. It cannot install dependencies or execute a repository's tests. A publication must state what was actually checked; GitHub CI supplies executable validation. SQLite transactions commit file mutations with their tool receipts so native execution recovery cannot apply an edit twice. Conversation, workspace and publication records survive object replacement. Explicit session cleanup removes them and retains a disconnection tombstone.
