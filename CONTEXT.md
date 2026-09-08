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

**Unknown result**:
An evaluation result indicating that Janitor cannot determine whether an issue or pull request matches, because required information is unavailable or AI classification is inconclusive. An unknown result preserves the existing label.
_Avoid_: Unknown outcome

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
