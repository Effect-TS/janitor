# Repository connections

Open **Connect repository…** in the repository switcher, or visit `/repositories/connect`. When the workspace is empty, Home offers the same flow. Search the inventory and connect one repository at a time. Missing repositories can be granted access through GitHub, then discovered with **Refresh repositories**.

Repository **Settings → Connection** provides pause, resume, access management, and disconnect. Disconnect keeps policies, rules, history, and existing GitHub labels. Reconnect opens Settings with automation paused so an operator can review saved rules before resuming.

## GitHub setup

Set the GitHub App's **Setup URL** to `https://<app-host>/repositories/connect/return`. Enable **Redirect on update** to return after installation access changes. This is an external GitHub App setting, separate from the OAuth callback URL. See [GitHub's setup URL documentation](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url).

If GitHub does not return automatically, open the connection page and refresh the inventory. Organization approval can delay availability. Expired attempts also recover through manual refresh. Returning from GitHub never connects repositories automatically.

## State and authorization

- `connected` controls workspace membership. Newly discovered repositories require an explicit connection.
- `enabled` controls automation. Paused repositories remain in the workspace.
- `sync_enabled` independently controls GitHub synchronization. The connection panel reports when sync is paused.

The API retains the application's Cloudflare Access trusted-operator model. Connection attempts bind a random, single-use state to the Access issuer and subject for 20 minutes. Callback installation IDs do not grant authority. Connect and resume verify current repository access using the installation credential and compare the stable GitHub repository ID.

Connection changes are transactional and audited. Disconnect takes the repository row lock shared by label writes, waits for tracked writes to finish, and prevents later writes or sync work. An external request already sent cannot be recalled. Previously started AI requests may finish, but their results cannot bypass the label-write check.

Migration `0006_repository_connections.sql` preserves existing workspace membership, including paused repositories. Inventory discovery and webhooks do not reconnect explicitly disconnected repositories.

## Recovery

The picker polls inventory for two minutes and offers manual refresh. Initial sync does not block policy authoring. Settings reports sync failures and offers Retry sync for active repositories. Access loss provides a GitHub repair action; restoring GitHub access alone does not reconnect a disconnected repository.

Disconnecting the last repository returns to the welcome screen. Other disconnects select another accessible repository. Direct links to a disconnected repository show retained-data information and a reconnect control.
