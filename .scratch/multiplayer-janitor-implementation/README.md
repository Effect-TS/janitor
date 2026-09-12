# Multiplayer Janitor implementation tickets

Fourteen approved implementation slices, using the [accepted specification](spec.md). All tickets start as ready-for-agent; take a ticket only when every blocker is complete. The settled product and technical maps are unchanged.

| Ticket                                                                                                   | Blocked by |
| -------------------------------------------------------------------------------------------------------- | ---------- |
| [01: Connect and manage teammate identities](issues/01-connect-team-identities.md)                       | None       |
| [02: Run a durable agent conversation](issues/02-durable-agent-conversation.md)                          | None       |
| [03: Collaborate with Janitor in a private Slack thread](issues/03-slack-shared-conversation.md)         | 01, 02     |
| [04: Observe sessions and recorded usage in Janitor](issues/04-session-observation.md)                   | 03         |
| [05: Let an agent inspect a repository](issues/05-inspect-repository.md)                                 | 02         |
| [06: Edit, test and recover repository work](issues/06-edit-test-recover.md)                             | 05         |
| [07: Publish new work as a pull request](issues/07-publish-new-pr.md)                                    | 03, 06     |
| [08: Collaborate on an existing pull request](issues/08-existing-pr-collaboration.md)                    | 07         |
| [09: Address GitHub review feedback automatically](issues/09-github-review-feedback.md)                  | 08         |
| [10: Recover missed events and interrupted platform delivery](issues/10-platform-recovery.md)            | 04, 09     |
| [11: Preserve or clean up work when repository access changes](issues/11-repository-access-lifecycle.md) | 04, 07     |
| [12: Upgrade running sessions safely](issues/12-safe-session-upgrades.md)                                | 10, 11     |
| [13: Validate a deployment model and credential rotation](issues/13-deployment-model-validation.md)      | 06         |
| [14: Verify the complete team workflow for release](issues/14-release-team-workflow.md)                  | 12, 13     |

## Initial frontier

- [Connect and manage teammate identities](issues/01-connect-team-identities.md)
- [Run a durable agent conversation](issues/02-durable-agent-conversation.md)

These may start independently. Every slice includes its own acceptance tests; the release ticket verifies the assembled workflow.
