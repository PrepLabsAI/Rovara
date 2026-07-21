# AgentX

AgentX is a remote coding agent that lives in your Slack workspace and manages the end-to-end lifecycle of a code change — from requirement gathering to implementation, local testing, PR creation, review, and (optionally) automerge.

You tag it in Slack, give it a task, and it does the work in a remote environment against your own repositories.

## Product Requirements

### 1. Slack-first interface

- AgentX is installed as a Slack app into the user's workspace.
- Users interact with it by mentioning it in a channel or thread and describing the task in natural language.
- Two invocation commands, which select the working mode:

| Command | Mode | Behavior |
|---|---|---|
| `@agent-quick` | Quick change | Jumps straight to implementation. Best for small, well-scoped changes (bug fixes, config tweaks, small features). Minimal back-and-forth. |
| `@agent-spec` | Spec-based coding | First produces a spec (requirements, approach, affected files, test plan) and posts it back to the Slack thread for user approval. Implementation starts only after the user signs off on the spec. Best for larger or ambiguous work. |

- All progress updates, questions, and results (spec, PR link, test results, review status) are posted back into the originating Slack thread, so the thread is the audit trail for the task.

### 2. Repository access & configuration

- During onboarding, the workspace admin (or an individual user) connects AgentX to their code hosting provider and selects which repositories AgentX may access.
- Per-repo configuration includes: default branch, how to run tests, and the risk/automerge policy (see §5).

**Open question — how does AgentX clone the repo?** Candidate approaches:

1. **GitHub App installation (likely default):** AgentX is installed as a GitHub App on selected repos. It mints short-lived installation tokens to clone, push branches, and open PRs. Fine-grained, revocable, no long-lived credentials stored.
2. **OAuth on behalf of the user:** acts with the user's identity; simpler but broader scope and PRs appear to come from the user rather than the bot.
3. **Deploy keys / PATs supplied by the user:** fallback for GitLab/Bitbucket/self-hosted until first-class apps exist for those providers.

Decision needed: start GitHub-only with a GitHub App, add other providers later.

### 3. Remote Development Environment (RDE)

When a task is accepted, AgentX provisions an isolated, ephemeral remote environment where it clones the repo, makes changes, and runs tests. One environment per task; destroyed after the PR is raised (or after a retention window for debugging).

**Decision: devcontainer-driven setup.** The repo's `.devcontainer/devcontainer.json` is the source of truth for the environment — base image, features, setup commands (`postCreateCommand`), and required services (via docker-compose). This is industry-standard, user-controlled, and means the agent's environment matches what developers already use locally and in Codespaces.

- If a repo has no devcontainer, AgentX falls back to auto-detection from lockfiles (`package.json`, `pyproject.toml`, `go.mod`, …), posts what it inferred to the Slack thread, and offers to open a PR adding a generated `devcontainer.json` so subsequent tasks are deterministic.
- Test/lint commands not expressible in devcontainer.json can be declared in repo config (see §2) or inferred from CI config.

**Open question — sandbox infrastructure:** what the devcontainer runs *on*. Candidates: Firecracker microVMs (e.g. Vercel Sandbox, Fly machines), gVisor containers, or plain Docker on a job runner (e.g. Kubernetes Jobs). Requirements regardless of choice: network egress controls, per-task isolation (untrusted code runs here), secrets injection for repo tokens, and a hard timeout/cost cap per task. Note: devcontainers assume a Docker-compatible runtime, so the choice must support running OCI images and ideally docker-compose (for service containers).

### 4. Task execution flow

1. User tags `@agent-quick` or `@agent-spec` with a task description.
2. AgentX acknowledges in-thread and (spec mode only) posts a spec for approval.
3. AgentX provisions the RDE, clones the target repo, and sets up the project.
4. It implements the change on a new branch.
5. **Local testing:** it runs the repo's test suite (plus any new tests it wrote) inside the RDE and iterates until green. Test results are posted to the thread.
6. It pushes the branch and raises a PR, linking it in the Slack thread. The PR description includes the original task, a summary of changes, and test evidence.

### 5. Review & automerge

- **Review integrations:** users can connect their existing AI code-review tool (Greptile, CodeRabbit, etc.) and/or rely on human reviewers. AgentX waits for the configured review to complete and responds to review comments by pushing fixes (within a bounded number of iterations).
- **Risk-based automerge:** each repo (or task) carries a risk level that determines what happens after checks pass:

| Risk level | Behavior after tests + review pass |
|---|---|
| Low | Automerge the PR and notify the thread. |
| Medium | Request a human approval (Slack button / GitHub approval) before merging. |
| High | Never automerge — PR is left for the team's normal process. |

- Risk level could be set per-repo, overridden per-task, or eventually inferred (e.g. changes touching auth/payments/migrations are always High).

### 6. Agent engine — no model lock-in

**Decision: AgentX must not be locked to a single LLM vendor.** The coding-agent harness (agentic loop, file/bash tools, subagent orchestration) is therefore an off-the-shelf **model-agnostic engine**, kept behind a pluggable interface — not the Claude Agent SDK, which is Claude-only.

- **Engine shortlist** (evaluated Jul 2026): **OpenHands Agent SDK** (MIT, Python, LiteLLM → 100+ providers, in-process library, subagent delegation, Docker/K8s workspaces — closest feature match) and **OpenCode** (MIT, TypeScript, 75+ providers, headless `opencode serve` + typed SDK — largest community). Runner-up: **Cline SDK** (Apache-2.0, TS, in-process, multi-agent teams; young). The control plane's implementation language is the tiebreaker.
- **Pluggable interface:** the engine sits behind a coarse `AgentEngine` contract — *task + workspace in → event stream out → local branch + summary + test evidence as the result*. One thin adapter per engine; swapping engines is a config change, and engines can be A/B tested per model.
- **Boundary decisions:**
  - The engine's job **ends at a local branch**. Pushing, opening the PR, and PR formatting belong to the control plane — credentials stay out of engine reach and PRs look uniform regardless of engine.
  - **Spec mode is two engine invocations** (plan → Slack approval → implement with approved spec), so the interface never needs mid-run bidirectional chat — the least portable feature across engines.
  - Engine-specific features pass through an opaque `engineConfig` blob rather than widening the typed contract (avoids lowest-common-denominator drift).
- **Conformance suite:** a set of golden tasks ("fix this failing test", "add an endpoint") runs against every adapter in CI — guards engine upgrades/swaps and doubles as the harness for benchmarking engines and models.

### 7. Non-functional requirements

- **Security:** short-lived credentials only; RDE sandboxing (untrusted code execution); no repo data retained after task completion beyond logs the user opts into.
- **Observability:** every task has a full trace (Slack thread + internal logs) of what the agent did.
- **Cost control:** per-task compute budget and timeout; per-workspace quotas.
- **Concurrency:** multiple tasks can run in parallel, each in its own RDE.

## Architecture (high level)

> Full design — layers, task lifecycle, state machine, engine interface, event protocol, security model, conformance suite — lives in [ARCHITECTURE.md](ARCHITECTURE.md).

```
Slack workspace
   │  @agent-quick / @agent-spec (events via Slack app)
   ▼
Control plane  ──  task queue, repo/token management, spec approval,
   │               PR lifecycle, review loop, risk-based automerge
   ▼  provisions per task
RDE (devcontainer sandbox)
   └─ agentx-runner   ← the only component that knows which engine is used
        └─ EngineAdapter → OpenHands SDK │ opencode serve │ (optional) Claude Agent SDK
```

- **Control plane** owns everything user- and Git-facing; it consumes a normalized event stream (`progress`, `spec`, `approval_request`, `usage`, `done`, `failed`) from the runner and relays it to the Slack thread.
- **`agentx-runner`** is a thin process shipped into every RDE; it loads the configured adapter, runs the engine against the task spec, and emits events (JSONL) back to the control plane.
- Per-engine prompt tuning (house rules, "run tests before finishing", commit conventions) lives in the adapter; task instructions stay engine-neutral.

## Open Questions

1. Repo access mechanism (§2) — GitHub App vs OAuth vs user-supplied credentials.
2. RDE sandbox infrastructure (§3) — what the devcontainer runs on (microVMs vs gVisor vs Docker-on-K8s). Setup strategy is decided: devcontainer-driven.
3. Implementation language for the `agentx-runner` (§6) — the runner hosts the engine adapter, so *its* language constrains engine choice (OpenHands adapter needs a Python runner; OpenCode only needs an HTTP client). The control plane's language is independent — runner ↔ control plane is a wire protocol.
4. Which review integrations to support first (Greptile, CodeRabbit, native GitHub reviews?).
5. How review-comment iteration is bounded (max rounds? escalate to human in Slack?).
6. Deployment step — the original vision includes deployment after merge; scope and mechanism TBD.
7. Pricing/quota model per workspace.
