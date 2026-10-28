# The chat bot is a cluster entity behind a policy egress proxy

Status: accepted.

Janitor's chat bot, reached from Slack and Discord, runs as one cluster Entity per chat thread, the chat session. It follows ADR 0012: the Entity owns the session's messages, its turns and the agent history in its own Durable Object SQLite, and the clanka loop runs in the Worker against a sandbox container reached over executor RPC. The model key, and every GitHub and Multica credential, stay out of the container.

The session handles one message at a time. It stores each message once, keyed by the platform's message id, so a Slack retry, the double delivery of `app_mention` and `message.*`, or a Discord resume redelivering a message is stored and acted on once. It then decides what the message is, in trusted code: context only when an outsider or a bot wrote it, "stop" when that is all it says, a mention, or a question for the reply gate. A mention or a passed gate starts a turn, or is steered into the running one; a message that arrives as a turn ends starts the next turn. The `Receive` reply comes once that is decided, never after the turn, so ingress sends it without waiting.

A turn holds keep-alive, so a restart rebuilds the Entity and the turn resumes. The history is committed step by step behind the same commit boundary as PR review, and a resume continues from the last committed step in a fresh sandbox, with a message that the sandbox is new and that pushed, opened, merged or commented work must be checked before it is redone. A turn may resume three times (`CHAT_MAX_RESUMES`). Its 17-minute wrap-up and 20-minute deadline count from when it first got a sandbox, so queue time doesn't count and resumes don't reset them.

The reply gate is Jev through `DecisionModel`, as labeling uses (ADR 0013), with its own `CHAT_GATE_MODEL` setting and labeling's `OPENROUTER_API_KEY`. It reads the thread's last 20 messages tagged by author class and answers one probability; it fails closed.

All container HTTP and HTTPS goes through the egress proxy, which drops the container's `Authorization`, injects the bot App's per-org installation tokens and the Janitor user's Multica PAT, and refuses writes to protected refs, tags and releases. The model is told the write rules, but the proxy enforces them; the sandbox's own placeholders carry no authority. This is what makes full tool access acceptable: what the bot can change on GitHub is bounded by the proxy, not the prompt.

The bot ships dark. With `CHAT_AI_API_URL` or `CHAT_AI_API_KEY` unset, the Worker reads no other chat bot setting and binds no chat session. A kill switch, global or per platform, stops running turns and starts none while it is on.

Accepted risks are listed in the design spec (EFF-3015): a branch the bot pushes runs the repository's workflows, the bot can approve and merge, private content on public Discord channels is kept out by the prompt alone, and there are no per-person caps.
