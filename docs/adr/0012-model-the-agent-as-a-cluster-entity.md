# Model the agent as a cluster entity with embedded workflows

Status: accepted, amended (2026-10) to resume a run on a fresh sandbox. Supersedes ADR 0010's choice to model the entire review run as a Workflow.

The agent is a persistent cluster Entity: it receives messages, owns agent state, and emits messages. Embedded Effect Workflows model durable actions such as invoking the LLM and publishing to GitHub. The Entity owns the agent's lifecycle and decisions; Workflow execution is an implementation of an action, not the identity or state model of the agent itself.

Persist messages and agent state explicitly. Give each action a stable identity so completed results can be consumed without repeating the action. Activities retain their role inside workflows for idempotency and external-write reconciliation. A lost GitHub response still requires reconciliation, and fresh authorization belongs inside each actual write attempt.

Use one agent Entity per review run. A separate per-issue scheduler coordinates runs and publications, preserving independent instructions and execution state for each invocation.

A runner restart restores persisted agent state and resumes the run. Reuse completed LLM results rather than issuing those calls again: the history is stored one row per message and committed step by step, so a resume continues from the last committed step. A resume gets a fresh sandbox, checked out again at the pinned head, and the agent is told that anything it installed, built or changed is gone. A run may resume three times (`PR_REVIEW_MAX_RESUMES`); the next acquire errors the run, and a re-run needs a new invocation. Cancellation, authorization changes, and the run's 10-minute deadline, counted from its first start, still govern recovery.

This refines ADR 0010's earlier blanket no-restart rule by distinguishing actor recovery from loss of unfinished sandbox work. Invocation authority, sandbox isolation, and per-issue serialization are unchanged.
