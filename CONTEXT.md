# Janitor

Janitor automates labeling of open GitHub issues and pull requests. Closed issues and closed or merged pull requests are outside its current labeling scope.

## Language

**Policy**:
A named set of conditions belonging to one repository, defining which issues or pull requests are in scope and whether they match. Evaluation can produce a match, non-match, unknown, or not-applicable result.
_Avoid_: AI policy, classifier

**Policy target**:
The kind of item a policy evaluates: either issues or pull requests. Each policy has exactly one target.

**Policy reference**:
A condition that uses another policy's current published version in the same repository to determine a match. Publishing a new version of the referenced policy changes how its consumers evaluate without requiring them to be republished.

**Facts**:
Information about an issue or pull request that policies inspect, such as its author, changed files, or review status.

**Condition**:
A test of facts or another policy's result, used to determine a policy's scope or whether it matches.

**Policy version**:
A particular edition of a policy, which can be a draft being edited or a published version. Publishing a version makes it the policy's current published version and retains the previous published version as history.

**Current published version**:
The published version of a policy that its labeling rules automatically use; multiple rules in the same repository can share that policy. Publishing a replacement updates which version all those rules use without requiring edits to the rules.

**Labeling rule**:
A configuration governing a GitHub label on an issue or pull request, based on either a policy or AI classification. Match and non-match results each independently specify whether to ensure the label is present, ensure it is absent, or leave it unchanged.

**Gate policy**:
A policy that determines whether an AI labeling rule should run its classification for an issue or pull request.

**Label ownership**:
Within a repository, at most one labeling rule may control a given label for a given target, and disabled rules retain that ownership. Separate rules may control that label for issues and pull requests.

**AI labeling rule**:
A labeling rule that uses an AI prompt to evaluate an issue or pull request, subject to a minimum confidence threshold and an optional gate policy. Its label behavior is configurable for match and non-match results.

**AI prompt**:
Instructions describing what an AI labeling rule should determine about an issue or pull request. Only facts explicitly referenced in the prompt are supplied for classification.

**AI provider and model**:
The AI service and model shared by all AI labeling rules in a Janitor deployment. They are deployment-wide choices rather than per-rule settings.

**Minimum confidence**:
The confidence threshold an AI classification must meet for Janitor to accept a match. Below that threshold, the result is a non-match.

**Cached AI result**:
A previous successful AI classification reusable for a deployment-wide lifetime, defaulting to 24 hours, while the AI rule's parameters, referenced facts, and AI model remain unchanged. Expiration or a parameter change, including minimum confidence, requires a fresh AI request on the next evaluation rather than triggering one immediately.

**Unknown result**:
An evaluation result indicating that Janitor cannot determine whether an issue or pull request matches because required facts are missing. Missing facts produce an unknown result rather than a non-match, preserving the existing label.
_Avoid_: Unknown outcome

**Failed evaluation**:
An evaluation that could not complete because of an operational error, such as an AI request timeout or provider error, with an actionable error explaining the failure. It leaves the rule's label unchanged, or all labels in its labeling group unchanged, while unrelated rules may still apply their label actions.

**Evaluation retry**:
A limited automatic reattempt of an evaluation after a temporary failure, with increasing delays and respect for provider retry guidance; configuration errors fail immediately, and exhausted retries leave a failed evaluation awaiting a new webhook event. Labels remain unchanged during retries, and newer webhook events supersede retries of outdated evaluations.

**Not-applicable result**:
An evaluation result indicating that an issue or pull request is outside a policy's scope. It is distinct from a non-match: the rule requests no label change and does not prevent other rules in its labeling group from acting.

**Labeling group**:
A named group of labeling rules belonging to one repository and targeting either issues or pull requests, whose labels are mutually exclusive, with priority selecting the winner among rules requesting that their labels be present. When every rule has a known result, only the winner's label remains, or none if no rule requests its label be present; an unknown result leaves all of the group's labels unchanged.
_Avoid_: Rule group

**Priority**:
A labeling rule's unique rank within its labeling group, with larger numbers taking precedence when selecting which requested label remains. Two rules in the same labeling group cannot share a priority, and disabled rules retain their reserved priority.

**Disabled labeling rule**:
A labeling rule that does not participate in evaluation while retaining its label ownership and any reserved group priority. Disabling it leaves existing labels in place, but its labeling group may later remove its label to enforce exclusivity.

**Labeling rule deletion**:
Removal of a labeling rule, releasing its label ownership and any reserved group priority. Deleting a rule leaves its existing labels on issues and pull requests.

**Ensure present**:
A label action requiring the label to be present after evaluation. A manual removal does not override the rule: Janitor adds the label back on the next evaluation that requests it.

**Ensure absent**:
A label action requiring the label to be absent after evaluation, including when someone added it manually. It applies only when the rule requests removal for the evaluation's result.

**Leave unchanged**:
A label action that preserves whether the label is currently present or absent, including manual changes. A labeling group's exclusivity decision can still require its removal.

### Repository connections and synchronization

**Repository visibility**:
A GitHub repository's public or private status. Both follow the same connection, permission, and automation rules in Janitor.

**Repository identity**:
The identity of a GitHub repository independent of its name or owner. Renaming or transferring it preserves its Janitor connection, policies, and labeling rules, with operation after a transfer subject to the required GitHub access under the new owner.

**GitHub App installation**:
An authorization for Janitor's GitHub App to access repositories belonging to a GitHub account. It determines which repositories are available to connect to Janitor.

**Connected repository**:
A GitHub repository explicitly selected for management in Janitor, with successful initial synchronization required before automation runs. GitHub App access makes a repository available to connect, but does not itself connect it.

**Available repository**:
A GitHub repository that Janitor's GitHub App can access but that has not been connected to Janitor. Newly granted access makes it available; someone must explicitly connect it before Janitor manages it.

**Required GitHub permissions**:
The permissions Janitor needs to read a repository's facts and change its labels. Both are required before connection, and losing either puts a connected repository into the access-unavailable state.

**Repository automation**:
All Janitor automations operating on a repository, currently automatic labeling and including any automation types added in the future.

**Paused repository**:
A connected repository whose automations and synchronization pipeline are stopped, retaining its configuration and existing labels. Incoming webhook requests are acknowledged without saving their events, updating stored facts, or triggering automation.

**Repository resumption**:
The re-enabling of a paused repository, requiring successful synchronization against GitHub's current state before automation runs again. Events received while paused are not replayed.

**Repository disconnection**:
Removal of a repository from Janitor's management, deleting its policies, labeling rules, stored facts, and event history. Labels already present on GitHub remain unchanged.

**Access unavailable**:
A repository state in which Janitor lacks the GitHub access needed to operate, stopping automation and synchronization while retaining configuration and stored data. Restoring access leaves deliberately paused repositories paused; otherwise, fresh synchronization is required before automation resumes.

**Synchronization**:
Janitor requesting current information from GitHub to refresh its stored facts, separately from updates received through webhook events.

**Manual synchronization**:
A user-requested synchronization that refreshes a repository's stored facts without triggering automation. It is unavailable while the repository is paused; the user must resume the repository first.

**Automation blocked by synchronization failure**:
A repository state in which a failed synchronization prevents all automation while configuration, stored facts, and existing labels are retained. Janitor retries synchronization automatically and resumes automation after successful synchronization unless the repository has been manually paused.

**Automation readiness**:
The state after successful initial synchronization or synchronization following repository resumption, in which new incoming webhook events may trigger automation. Becoming ready does not itself run automation on existing issues or pull requests.

**Automatic labeling**:
Evaluation of labeling rules for the open issue or pull request concerned by a new incoming webhook event, rather than every open item in the repository. Publishing a policy or changing a labeling rule affects future evaluations without triggering an immediate labeling run.

**Automation recovery**:
The clearing of a synchronization-failure block after successful synchronization, allowing future incoming webhook events to trigger automation. Recovery does not run catch-up automation or replay events received while blocked.

**Webhook updates**:
Changes to Janitor's stored facts from incoming GitHub webhook events. They continue while automation is blocked by synchronization failure, without running automation or clearing the block, but stop when the repository is manually paused.
