# Allow sandbox internet access for the MVP

Status: accepted.

Issue review targets open-source repositories and uses a sandbox image with Node.js, pnpm, and common system tools to install public packages and run tests. Allow outbound internet access for the MVP instead of introducing a dependency service or registry allowlists. This simplifies installation and testing but allows repository scripts to contact external services; Janitor does not claim network isolation.

This supersedes the original restricted-egress requirement for issue review. GitHub, Slack, and model credentials must still remain outside the sandbox. Authenticated GitHub and Slack integration and all publication remain in trusted orchestration. Internet access does not grant sandbox code those credentials or publication authority.
