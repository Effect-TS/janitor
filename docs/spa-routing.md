# SPA routing

Repository onboarding uses `/repositories/connect` and `/repositories/connect/return`. These reserved paths precede repository-ID routes. Home shows a welcome screen after a successful empty workspace response. The picker preserves the previous route for Cancel and respects the unsaved-edit guard. Repository Settings includes connection, pause/resume, and disconnect controls.

The web application uses Foldkit's `Route` parsers and URL builders, runtime URL events, and `Navigation` effects. Routes live in `apps/web/src/routes.ts`.

| Path                                             | Screen                                                 |
| ------------------------------------------------ | ------------------------------------------------------ |
| `/`                                              | Last-used accessible repository, or repository chooser |
| `/repositories/:repositoryId`                    | Redirect to the repository's policies                  |
| `/repositories/:repositoryId/policies`           | Policy library                                         |
| `/repositories/:repositoryId/policies/new`       | New policy                                             |
| `/repositories/:repositoryId/policies/:policyId` | Policy document and test bench                         |
| `/repositories/:repositoryId/rules`              | Rules                                                  |
| `/repositories/:repositoryId/rules/new`          | New rule                                               |
| `/repositories/:repositoryId/rules/:ruleId`      | Rule editor                                            |
| `/repositories/:repositoryId/rules/test`         | Configuration test bench                               |
| `/repositories/:repositoryId/activity`           | Evaluation and reconciliation history                  |
| `/repositories/:repositoryId/settings`           | Synchronization and AI settings                        |

Repository and document IDs are stable identifiers, independent of their editable names. Reserved `new` and `test` routes are matched before dynamic IDs. Unknown paths, unavailable repositories, and missing documents have explicit error states.

## Navigation

The URL selects the repository, section, and open document. Direct links load repository data before opening the document. Late responses from another repository or document are ignored. Sidebar and policy-library links support normal browser link behavior, including opening in a new tab.

Switching repositories keeps the current section and closes the document. Closing an editor returns to its list. Saving a new policy replaces the creation URL with its ID while retaining the editor and any newer input. Saving a rule returns to the rules list.

The last accessible repository is remembered in local storage. A first visit without a remembered repository shows a chooser.

## Query parameters

Policy routes accept:

- `q`: policy-library search text.
- `item`: positive issue or pull-request number selected in the policy test bench.

Changing either parameter replaces the current history entry and keeps the document open. Selecting a test item does not run an evaluation. Test candidates still depend on the policy target and the available open items.

## Unsaved changes

Leaving an edited policy or rule asks whether to discard unsaved changes. This includes uncommitted title and description input. An unchanged saved draft does not prompt just because it has never been published.

Browser Back/Forward uses the same protection. History entries carry an index so cancelling restores the original entry without overwriting the destination or losing Forward history. Navigation away is blocked while a save is in flight. A scoped `beforeunload` subscription protects refreshes and full-page navigation while input is unsaved.

## Hosting

Vite serves the SPA entry point for direct development URLs. The existing Alchemy `Cloudflare.Website.Foldkit` resource configures `single-page-application` asset fallback in production. API traffic continues to use `/api`.

Route parsing and loading behavior are covered by `apps/web/test/routes.test.ts` and `apps/web/test/routing.test.ts`.
