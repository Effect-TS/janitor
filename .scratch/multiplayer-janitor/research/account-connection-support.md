# Account connection and private onboarding support

Researched 2026-09-11 for "Verify account connection and private onboarding support". This records capabilities and remaining checks, without choosing a new onboarding flow.

## Private onboarding replies

| Incoming event                      | Supported private response                                                                                         | Walkthrough consequence                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Slack ordinary message or mention   | `chat.postEphemeral` takes a channel and target user, with `chat:write`. It does not require an interaction token. | Janitor can privately direct an unconnected sender to Connected accounts. |
| Slack app interaction               | Interaction responses support ephemeral messages through `response_url` when supplied.                             | Private onboarding is also possible from supported app interactions.      |
| Discord app interaction             | Interaction callbacks support the `EPHEMERAL` flag.                                                                | An interaction can produce a response visible only to its invoking user.  |
| Discord ordinary message or mention | The normal Create Message API cannot set `EPHEMERAL`.                                                              | Do not depict an ordinary mention receiving an ephemeral channel reply.   |

Slack supports `thread_ts`, but only displays thread ephemeral messages when an active thread already exists. Delivery is best effort, requires an active user in the channel, and does not persist across sessions. A channel-level ephemeral response is available before a thread exists. [Slack chat.postEphemeral](https://docs.slack.dev/reference/methods/chat.postEphemeral/). Slack interaction response behavior is documented separately. [Slack interaction handling](https://docs.slack.dev/interactivity/handling-user-interaction/).

Discord's ephemeral capability belongs to interaction responses. Its ordinary Create Message flags exclude `EPHEMERAL`; receiving a message does not itself provide an interaction callback. [Discord interaction responses](https://docs.discord.com/developers/interactions/receiving-and-responding), [Discord message API](https://docs.discord.com/developers/resources/message).

A Discord DM is a possible private alternative for ordinary messages. Discord provides Create DM and advises using it in response to user action, with rate limits on opening conversations. That establishes an option, not guaranteed delivery or a selected product fallback. [Discord user API](https://docs.discord.com/developers/resources/user#create-dm). The agreed conditional wording, private where supported, can retain a short ordinary reply where necessary. Requiring an interaction or trying a DM first would be separate product choices.

## Existing sign-in identity

The local Access application restricts sign-in to the configured GitHub IdP and the `Effectful-Tech` organization. The runtime's `AccessIdentity` contains issuer, subject, optional email, and expiry. It defines the audit identity as issuer plus subject and uses email only for display. Neither its decoded claims nor returned identity contain GitHub login or numeric user ID. See [Access application](../../../apps/cluster/src/Ingress/Access.ts) and [JWT verifier](../../../apps/cluster/src/Ingress/AccessJwt.ts).

Cloudflare documents a separate authenticated `/cdn-cgi/access/get-identity` request using the application cookie. Its response includes `idp` data and `user_uuid`. This is a route to investigate for reusing existing sign-in. The reviewed documentation does not promise a GitHub-specific numeric ID or login inside that data. Do not treat the Access subject as a GitHub user ID or infer a login from email. [Cloudflare application token and full identity](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/).

The configured IdP uses a GitHub OAuth app registered with Cloudflare. That does not establish that Janitor receives the upstream GitHub token. [Cloudflare GitHub integration](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/github/).

An additional GitHub user authorization flow is a documented fallback if Access cannot supply the required identity. GitHub's web flow exchanges a user authorization code for a user access token and demonstrates calling `GET /user`. That endpoint returns `id` and `login`, and supports GitHub App user access tokens without additional endpoint permissions. This proves the authenticated GitHub account; Janitor would still associate it with its signed-in team member and apply team eligibility. [GitHub user authorization flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), [GitHub authenticated user](https://docs.github.com/en/rest/users/users#get-the-authenticated-user).

## Remaining checks

- Inspect the deployed Access identity response in a later implementation investigation without logging cookies or credentials. A documented, verified GitHub identity from existing sign-in would avoid an extra connection step; this research has not established that the deployment supplies one.
- If it does not, decide whether Connected accounts includes a GitHub authorization step. No automatic username mapping was established here.
- In the walkthrough, distinguish Slack ephemeral replies and Discord interaction replies from Discord ordinary message replies. The existing private-where-supported decision remains viable. No new mandatory approval step follows from these findings.

This was a source review, with no live Slack, Discord, Cloudflare, or GitHub authentication experiment. Product code was not changed. `vp install` could not run in the research worktree because `vp` is unavailable in this environment; no project checks are claimed.
