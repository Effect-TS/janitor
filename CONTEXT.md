# Janitor

Janitor manages connected GitHub repositories through automatic labeling. Closed issues and closed or merged pull requests are outside its labeling scope.

## Language

**Policy**:
A named set of conditions belonging to one repository, defining which issues or pull requests are in scope and whether they match. Evaluation can produce a match, non-match, unknown, or not-applicable result.
_Avoid_: AI policy, classifier

**Item**:
An issue or a pull request: the unit automatic labeling and the test bench evaluate. Its facts are read from GitHub when the evaluation runs.

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
A configuration governing a GitHub label on an issue or pull request, based on either a policy or AI classification. Match and non-match results each independently specify whether to ensure the label is present, ensure it is absent, or take no action.

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
A previous successful AI classification reusable for a deployment-wide lifetime, defaulting to 24 hours, while the AI rule's parameters, referenced facts, and AI model remain unchanged. Expiration or any parameter change, including minimum confidence, label actions, or priority, requires a fresh AI request on the next evaluation rather than triggering one immediately.

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
A named group of labeling rules belonging to one repository and targeting either issues or pull requests, with priority selecting the sole label to retain among applicable rules requesting presence, or no label when applicable rules request none. All group labels remain unchanged if no enabled rule applies or any enabled rule has an unknown result or failed evaluation.
_Avoid_: Rule group

**Priority**:
A labeling rule's unique rank within its labeling group, with larger numbers taking precedence when selecting which requested label remains. Two rules in the same labeling group cannot share a priority, and disabled rules retain their reserved priority.

**Disabled labeling rule**:
A labeling rule that does not participate in evaluation while retaining its label ownership and any reserved group priority. Disabling it leaves existing labels in place, but its labeling group may later remove its label to enforce exclusivity.

**Labeling group reordering**:
A single change to the priorities of rules in a labeling group, allowing swaps while requiring all resulting priorities to be unique.

**Labeling rule deletion**:
Removal of a labeling rule, releasing its label ownership and any reserved group priority. Deleting a rule leaves its existing labels on issues and pull requests.

**Ensure present**:
A label action requiring the label to be present after evaluation. A manual removal does not override the rule: Janitor adds the label back on the next evaluation that requests it.

**Ensure absent**:
A label action requiring the label to be absent after evaluation, including when someone added it manually. It applies only when the rule requests removal for the evaluation's result.

**Take no action**:
The rule makes no request to add or remove its label. Its labeling group may still remove the label when choosing which label remains.
_Avoid_: Leave unchanged

### Team

**Authorized team member**:
Anyone Cloudflare Access lets sign in to Janitor. Every authorized team member has every permission; Janitor has no roles.

**Connected account**:
A GitHub account an authorized team member has proven they own. Each GitHub account belongs to one teammate at a time.

### Repository connections and synchronization

**Repository visibility**:
A GitHub repository's public or private status. Both follow the same connection, permission, and automation rules in Janitor.

**Repository identity**:
The identity of a GitHub repository independent of its name or owner. Renaming or transferring it preserves its Janitor connection, policies, and labeling rules, with operation after a transfer subject to the required GitHub access under the new owner.

**GitHub App installation**:
An authorization for Janitor's GitHub App to access repositories belonging to a GitHub account. It determines which repositories are available to connect to Janitor.

**Connected repository**:
A GitHub repository explicitly selected for management in Janitor. GitHub App access makes a repository available to connect, but does not itself connect it.

**Available repository**:
A GitHub repository that Janitor's GitHub App can access but that has not been connected to Janitor. Newly granted access makes it available; someone must explicitly connect it before Janitor manages it.

**Required GitHub permissions**:
The permissions Janitor needs to read a repository's facts and change its labels. Both are required before connection, and losing either puts a connected repository into the access-unavailable state.

**Repository automation**:
All Janitor automations operating on a repository, currently automatic labeling and including any automation types added in the future.

**Paused repository**:
A connected repository whose automations and synchronization pipeline are stopped, retaining its configuration and existing labels. Incoming webhook requests are acknowledged without saving their events, updating stored facts, or triggering automation.

**Repository resumption**:
The re-enabling of a paused repository, subject to valid GitHub access and workflow enablement. Synchronization readiness does not determine whether automation may resume.

**Repository disconnection**:
Removal of a repository from Janitor's management, deleting its policies, labeling rules, stored facts, and event history. Work and labels already published on GitHub remain unchanged.

**Repository block reason**:
A concrete reason repository work is refused, such as disconnection, unavailable GitHub access, or pause. Synchronization progress or failure is not a repository block reason.

**Repository reconnection**:
A fresh connection of a previously disconnected repository, starting without its former policies, labeling rules, or stored data. Existing GitHub labels remain unchanged.

**Access unavailable**:
A repository state in which Janitor lacks the GitHub access needed to operate, stopping affected work while retaining configuration and stored data. Restoring access leaves deliberately paused repositories paused.

**Synchronization**:
Refresh of Janitor's cached GitHub information for display in the frontend. It is solely a UI cache optimization, independent of automation eligibility.

**Manual synchronization**:
A user-requested synchronization that refreshes a repository's stored facts without triggering automation. It is unavailable while the repository is paused; the user must resume the repository first.

**Automation readiness**:
Eligibility to run repository automation, subject to connection, pause, valid GitHub access, and the workflow's enablement. Synchronization readiness or failure does not determine automation readiness.

**Automatic labeling**:
Evaluation of labeling rules for the open issue or pull request concerned by a new incoming webhook event, rather than every open item in the repository. Evaluations and each label write read the current facts from GitHub when they run, including the pull request collections the rules need; synchronization never admits, qualifies or blocks them. Publishing a policy or changing a labeling rule affects future evaluations without triggering an immediate labeling run.

**Webhook updates**:
Changes to Janitor's cached GitHub information from incoming webhook events.
