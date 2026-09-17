# Model the agent as a cluster entity with embedded workflows

Status: accepted. Supersedes ADR 0010's choice to model the entire review run as a Workflow.

The agent is a persistent cluster Entity: it receives messages, owns agent state, and emits messages. Embedded Effect Workflows model durable actions such as invoking the LLM and publishing to GitHub. The Entity owns the agent's lifecycle and decisions; Workflow execution is an implementation of an action, not the identity or state model of the agent itself.

Persist messages and agent state explicitly. Give each action a stable identity so completed results can be consumed without repeating the action. Activities retain their role inside workflows for idempotency and external-write reconciliation. A lost GitHub response still requires reconciliation, and fresh authorization belongs inside each actual write attempt.

This correction does not change invocation authority, sandbox isolation, per-issue serialization, or the 15-minute deadline. Entity lifetime and recovery after runner restart versus sandbox loss need clarification before the ticket breakdown is finalized. The earlier no-automatic-restart rule remains in force until that distinction is settled.
