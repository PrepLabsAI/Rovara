# E2E setup: connect, inspect, decide

AgentX proposes project E2E setup from a source snapshot. The proposal is a starting point for an owner decision; it does not establish that a live workflow or external service is ready.

## Connect a project

Run `agentx --env <name> project add` from the project checkout and select a GitHub repository the AgentX GitHub App can access. Connect issue trackers separately with `agentx --env <name> connector add <linear|jira|asana> --project <project>`.

## Inspect the proposal

Before saving E2E setup, AgentX shows the proposed setup and readiness commands, detected targets, mock-substitutable inputs, and unresolved blockers. Review the source-backed targets and every proposed command. A mock substitution is allowed only for inputs the proposal marks `mock-substitutable`; unresolved inputs marked `blocking` remain blockers.

## Approve or decline

Choose whether to use the proposed setup. AgentX records that choice against the immutable proposal reference and digest. Approving stores the proposal's E2E policy with the project revision. Declining records the decision and omits that E2E policy, so browser and API checks are off; the project keeps its own setup and test commands (the proposed ones and any you passed as flags), and you can run `agentx project setup-approve` later to turn the checks on.

A mock can support a local check of an isolated behavior. Approving that substitution keeps it in the saved proposal; it does not produce a runtime PASS or prove the corresponding live source, browser workflow, or customer path. Required evidence that remains missing or `UNKNOWN` must remain visible and cannot be treated as a pass.

If optional E2E discovery is unavailable or malformed, project onboarding can still complete; AgentX marks E2E discovery unavailable and keeps setup unresolved for a later retry. It does not turn partial discovery into an approved setup or runtime pass. A registered runtime catalog row is also not enough by itself: admission checks its scope, expiry, environment, installed manifest, and current worker readiness before execution.

Standard setup and feature runtime catalogs require a separate administrator-issued challenge and Linux ARM64 host qualification. Deployment provisions the pinned worker image and runtime prerequisites, but it does not run that qualification or register the catalogs. See [standard runtime qualification](runtime-installation.md) for the complete administrator/host/administrator procedure and its current limits.

## Evidence status

The [native P0 acceptance record](p0-native-journey-acceptance.md) summarizes the local synthetic journey, candidate-bound checks, evidence limits, and reproducible acceptance launcher. Its prior passing candidate does not qualify a later integrated commit; acceptance must be rerun against the exact candidate under review.
