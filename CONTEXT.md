# Janitor

Janitor manages connected GitHub repositories through automatic labeling, agent sessions, and explicitly invoked issue review. Closed issues and closed or merged pull requests are outside its labeling scope.

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

### Shared collaboration

**Shared work**:
An ongoing team effort with Janitor-run agents that teammates can join and steer. It may begin before an issue or pull request exists and later link to those artifacts.

**Agent session**:
An ongoing conversation with a Janitor-run agent that teammates can join and steer in its home thread. It can begin before repository selection and later use one repository and ref. After creation, ordinary messages from authorized teammates are agent inputs; messages arriving during active work queue for the next turn.

**Default agent model**:
The team-funded provider and model selected for new agent sessions in a Janitor deployment. It is separate from the provider and model used by AI labeling rules.

**Session model**:
The provider and model used for a session's turns. New Slack sessions use the deployment's current OpenRouter chat configuration, independently of labeling. Changing that configuration affects subsequent turns.

**Agent input**:
An authorized teammate instruction directed to an agent session. A delivery retry is the same input; two separately sent instructions remain distinct even when their text matches.

Once accepted, an input remains part of the shared session even if its author disconnects their account or loses team eligibility; its original authorship is preserved.

**Agent turn**:
An interval of agent work within an ongoing session that may include several model responses and tool operations. Finishing a turn leaves the session available for later inputs. New Slack sessions report interrupted turns without replaying them, then continue with later inputs.

**Home thread**:
The single private-channel thread where teammates participate in an agent session. The MVP uses Slack; Discord is planned for a later release.

**Authorized team member**:
A teammate admitted through Janitor's team sign-in whose linked accounts may direct Janitor until disconnected or explicitly disabled in Janitor, independently of subsequent Cloudflare Access session expiry or eligibility. Authorized team members have equivalent control of sessions they can participate in; starting a session does not grant exclusive control.

**Teammate removal**:
An admin explicitly disabling a teammate's linked accounts in Janitor, preventing further instructions while preserving accepted work and historical attribution. Removing Cloudflare Access alone does not perform teammate removal in Janitor.

**Admin**:
An authorized team member permitted to change roles and remove or restore teammates in Janitor. Admins and members have equal control when collaborating with agents; the last active admin cannot be removed or demoted.

**Member**:
An authorized team member who may collaborate with agents but cannot change roles or remove or restore teammates. Newly admitted teammates are members unless explicitly assigned an admin role.

**Connected chat account**:
A Slack or Discord account associated with an authorized team member after sign-in to Janitor.

In the MVP, a teammate connects one Slack account per workspace, and each Slack account belongs to one teammate at a time.

**Slack session sandbox**:
A lazily started Node container owned by a Slack session's Durable Object. It holds one repository checkout and runs filesystem, Git and shell tools. Its files are ephemeral; conversation history and queued inputs survive container replacement, but unpublished edits may not.

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
Removal of a repository from Janitor's management, deleting its policies, labeling rules, stored facts, and event history. Slack sessions refuse subsequent tools against a disconnected repository but retain their conversation and workspace until separately removed. Work and labels already published on GitHub remain unchanged.

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
Changes to Janitor's cached GitHub information from incoming webhook events. A cache update does not itself authorize issue review.

### Issue review

**Issue review**:
An explicitly invoked investigation that classifies an issue, searches the same repository for related issues and pull requests, and checks evidence against a recorded default-branch commit. It does not apply labels or fix bugs.

**Authorized invocation**:
A free-form request mentioning Janitor directly from a human with effective write or admin permission on that repository. Ordinary issue activity and reporter replies without a direct invocation do not authorize work.

**Review run**:
One investigation requested by an authorized invocation, using that invocation's instructions and treating previous discussion and findings as evidence. Only one run is active per issue; later invocations wait in order.

**Review cancellation**:
Stopping an active or queued review run without undoing completed publications. A cancelled run cannot resume; further work requires a new invocation.

**Reproduction PR**:
A linked draft pull request containing a minimal test that executes and fails for the reported bug. It contains no bug fix and Janitor never automatically marks it ready for review.

**Confirmed fixed**:
A review finding supported by a relevant test that fails on an affected revision and passes on the recorded default-branch commit.

**Appears fixed**:
A review finding supported by code or pull-request evidence without an executable comparison confirming the fix. It states what remains unverified.

**Review summary**:
The single Janitor comment on an issue that summarizes findings and is updated on subsequent authorized runs.

**Review dry-run**:
An investigation whose findings and proposed test changes appear in the frontend without automatic GitHub publication. A separately authorized Publish results action may publish one saved result while dry-run remains enabled.

**Review publisher**:
A frontend user with current effective repository write or admin permission who explicitly authorizes publication of saved review results. The publisher may differ from the original invoker.
