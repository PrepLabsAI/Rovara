# Tasks: Releases Publish Only the EC2 Worker Settings

- [x] T001 `WorkerSettingsStack` replaces `AgentRuntimeStack` under the same stack name and logical IDs.
- [x] T002 `release:prod` and `agentx deploy` stop deploying and waiting on the AgentCore runtime.
- [x] T003 Tests, template snapshot and `docs/architecture-production.md` updated; typecheck, lint and tests pass.
- [x] T004 After the release: SSM settings carry the release's image, the runtime stack has no AgentCore
  resources, and a new Slack thread prepares and runs on EC2.
  Verified 2026-09-27: the SSM worker image matched the release (version 8), the runtime stack held only the SSM parameters, and a new `personal-website` thread booted on it (#117).
