# Research: Project Worker Model Selection

## Decisions

- **Resolve at task acceptance**: the broker owns current project policy and authorization, so each new task is resolved there.
- **Store selection separately**: use `PROJECT#<name>` / `SELECTION`, preserving immutable revisions while recording `updatedAt` and `updatedBy`.
- **Use deterministic Slack commands**: parse `models` and `use <selector>` before workspace creation and orchestrator execution.
- **Make the task model optional**: new workers honor it; absent fields use `AGENTX_MODEL_PROVIDER` and `AGENTX_MODEL_ID`.
- **Validate availability operationally**: registration validates structure and membership; administrators verify account/region access to approved models.
