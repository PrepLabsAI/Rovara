# Developing Rovara

Local validation, the spec documents, and the GitHub Spec Kit setup.

## Local validation

Use Node 22.19 or newer (Node 22 LTS recommended):

```sh
npm ci
npm run typecheck
npm run typecheck:all
npm run lint
npm test
npm run infra:synth
```

`npm run typecheck:all` also type-checks tests/ and scripts/ (tsconfig.lint.json). Those files still
have known errors, listed per file in tests/typecheck-baseline.json. The check fails if a file gets
more errors than its baseline or a new file gets any. After you fix some, run
`npm run typecheck:baseline` to lower the baseline and commit it. It never raises a count.

The latest results are the CI runs on each pull request. Docker and AWS are not required for this
local suite.

For Bedrock/OpenRouter configuration, Slack model selection, and the live verification checklist, see [OpenRouter model access](openrouter.md). To use your own Anthropic or OpenAI API key, see [Your own Anthropic or OpenAI API key](model-providers.md).

## Implementation documents

- [Pull-request task list](../specs/002-create-pull-request/tasks.md): implementation and validation
  status for explicit publication.
- [Safe PR lifecycle task list](../specs/003-safe-pr-lifecycle/tasks.md): clean publication,
  append/sync, replacement, and revert progress.
- [Pull-request specification](../specs/002-create-pull-request/spec.md): publication behavior,
  safety, and retry requirements.
- [Conversation continuity task list](../specs/012-conversation-continuity/tasks.md): reopening a
  thread's saved session, and what is verified locally rather than on a deployment.
- [Task list](../specs/001-agentx-foundation/tasks.md): the foundation's implementation tasks, in
  dependency order.
- [Specification](../specs/001-agentx-foundation/spec.md): agreed workflows and acceptance criteria.
- [Plan](../specs/001-agentx-foundation/plan.md): architecture, boundaries and delivery sequence.
- [Research](../specs/001-agentx-foundation/research.md): decisions and primary sources.
- [Production AWS architecture](architecture-production.md): EC2 workers and persistent EBS,
  per-session EBS, networking, release, isolation, and migration boundaries.
- [Contracts](../specs/001-agentx-foundation/contracts/): project config, control API and worker protocol.
- [Validation guide](../specs/001-agentx-foundation/quickstart.md).
- [Installer specification](../specs/015-installer/spec.md) and
  [phase plans](../specs/015-installer/plans/README.md): `agentx init`, `upgrade`, `config`, `doctor`
  and `destroy` (phases 15a to 15e built).
- [MCP server specification](../specs/025-mcp-server/spec.md) and
  [phase plans](../specs/025-mcp-server/plans/README.md): developer sign-in, tasks from AI tools and
  sharing (phases 25a to 25c built; 25d and 25e not yet).
- [Local install page specification](../specs/040-install-ui/spec.md): `agentx init --ui` (phase 1
  built; phases 2 to 4 not yet).
- [Project configuration](project-configuration.md): every field of a project file.
- [Constitution](../.specify/memory/constitution.md): project principles, version 4.0.0.

## GitHub Spec Kit

Initialized with the official Specify CLI 1.0.7 and Codex skills integration:

```sh
uvx --from specify-cli==1.0.7 specify init --here --integration codex --integration-options="--skills" --script sh --ignore-agent-tools --non-interactive
```

Initialization has already run; do not rerun it over these artifacts unnecessarily.
The installed skills are in `.agents/skills/`, with templates/scripts under `.specify/`.

Spec Kit skills are agent instructions, not shell commands. No Git repository or branch was
created by this setup.

Validate the active feature now:

```sh
.specify/scripts/bash/check-prerequisites.sh --json --require-spec --require-tasks --include-tasks
```
