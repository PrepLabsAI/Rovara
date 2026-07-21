# AgentX Build Plan

Companion to [README.md](README.md) (requirements) and [ARCHITECTURE.md](ARCHITECTURE.md) (design). Phases are ordered to de-risk the hardest, most uncertain pieces first (engine loop → sandbox → GitHub plumbing → Slack UX → review loop), and each phase ends with something runnable.

**Status: awaiting review — no implementation started.**

## Proposed stack decisions (confirm at Phase 0)

| Decision | Proposal | Rationale |
|---|---|---|
| Language | **Python monorepo** (control plane + runner) | One language for v1; the runner must be Python anyway to host the OpenHands SDK in-process; Slack Bolt + FastAPI cover the control plane fine. |
| First engine | **OpenHands Agent SDK** | Closest feature match (library mode, LiteLLM multi-provider, subagents, workspace story). |
| Second engine (Phase 6) | **OpenCode** (via `opencode serve` + HTTP) | Proves the pluggable interface; adapter only needs an HTTP client. |
| Orchestrator hosting | **Amazon Bedrock AgentCore Runtime** (decided) | Control plane packaged as linux/arm64 image ≤ 2 GB; per-second billing that doesn't charge I/O wait suits an orchestrator that mostly waits. |
| Dev sandbox substrate | **Docker + devcontainer CLI on a single host** | Fastest path to working RDEs; used for development and the conformance suite throughout. |
| Production sandbox substrate | **ECS Fargate + prebuilt per-repo devcontainer images** (CodeBuild `devcontainer build --push` → ECR), **CodeBuild Sandbox** fallback for compose/DinD repos (decided — see ARCHITECTURE.md §9) | AgentCore sessions can't run Docker or arbitrary images, so RDEs live on Fargate (Firecracker isolation, clean teardown); implemented in Phase 6 behind the same `WorkspaceProvider` interface. |
| Persistence / queue | **Postgres** (state machine + tasks) + simple DB-backed queue | Boring and sufficient; swap for Redis/SQS only if throughput demands. |
| Git host (v1) | **GitHub only, via GitHub App** | Matches README §2 decision. |

---

## Phase 0 — Foundations (small)

Scaffolding and the decisions that everything else builds on.

- [ ] Confirm the stack decisions above (review gate).
- [ ] Monorepo scaffolding: `control-plane/`, `runner/`, `shared/` (event + task schemas), `fixtures/` (conformance), `infra/`.
- [ ] Define the wire schemas as code: `TaskSpec`, `EngineEvent`, `TaskResult` (pydantic models in `shared/`, versioned).
- [ ] CI: lint, type-check, unit tests on every PR.
- [ ] 2–3 golden fixture repos (start tiny): `fixture-failing-test` (Python), `fixture-small-feature` (Python), `fixture-ambiguous-task`.

**Exit criteria:** CI green on an empty-but-structured monorepo; schemas importable from both `control-plane` and `runner`; fixtures cloneable.

**Deliverables:** monorepo skeleton with CI pipeline · versioned `shared/` schema package (`TaskSpec`/`EngineEvent`/`TaskResult`) · 3 golden fixture repos.

## Phase 1 — Engine core, local-first (the heart)

Prove "task in → branch out" on a laptop, no sandbox, no Slack, no GitHub. This is the highest-uncertainty component, so it goes first.

- [ ] `agentx-runner` skeleton: read `TaskSpec` from file/stdin, emit JSONL `EngineEvent`s to stdout, exit codes mapped to terminal events.
- [ ] Supervision: wall-clock timeout, token-budget cutoff (from `constraints`), crash → `failed` event with log tail, SIGTERM-driven `cancel`.
- [ ] `EngineAdapter` base interface (mirrors `AgentEngine` from ARCHITECTURE.md §4).
- [ ] `OpenHandsAdapter`: conversation setup, LiteLLM model selection from `constraints.model`, event mapping (progress/usage/done), commit-to-branch convention.
- [ ] Quick mode end-to-end locally: run against `fixture-failing-test`, verify a branch exists where the test passes.
- [ ] Spec mode: planning invocation emits `spec` event; implementation invocation consumes `approvedSpec`.
- [ ] Conformance harness v1: script that runs all fixtures through the runner with a pinned model and applies oracles; wire into CI (manual trigger or nightly — it costs tokens).

**Exit criteria:** `agentx-runner --task task.json` on a laptop produces a green branch on all fixtures; conformance harness reports a pass/fail matrix.

**Deliverables:** `agentx-runner` package (supervision: timeout, budget, cancel, crash→`failed`) · `EngineAdapter` interface + `OpenHandsAdapter` · quick + spec mode working locally · conformance harness v1 with pass/fail matrix report.

## Phase 2 — RDE provisioning (the sandbox)

Wrap the runner in the devcontainer-based sandbox from README §3.

- [ ] `WorkspaceProvider` interface: `provision(repo, ref) → Workspace`, `exec_runner(ws, task)`, `teardown(ws)` — so the Docker implementation is swappable for a production substrate later.
- [ ] Docker implementation: clone repo → detect `.devcontainer/devcontainer.json` → build/start via devcontainer CLI → inject runner + task → stream events out.
- [ ] Auto-detection fallback when no devcontainer (lockfile-based base-image pick), with an "inferred setup" note surfaced in events.
- [ ] Resource limits (CPU/mem/disk), hard container timeout, guaranteed teardown (including on control-plane crash — reaper job).
- [ ] Egress policy v1: default-deny with allowlist (model provider, package registries, github.com).
- [ ] LLM key injection into runner env only; verify the workspace filesystem never contains it.

**Exit criteria:** conformance suite passes running *inside* provisioned RDEs (not on the host); a fixture with a devcontainer and one without both work; a runaway task is provably killed and reaped.

**Deliverables:** `WorkspaceProvider` interface (`provision`/`exec_runner`/`teardown`) · `LocalDockerProvider` (devcontainer CLI + auto-detect fallback) · egress-policy config + resource limits + reaper job · conformance suite running in-sandbox.

## Phase 3 — Control plane MVP + GitHub (headless end-to-end)

A PR gets opened with no Slack in the loop — driven by an internal API call.

- [ ] Task state machine + Postgres persistence (states from ARCHITECTURE.md §3), DB-backed work queue, worker process.
- [ ] GitHub App: app registration, installation webhook handling, per-task installation-token minting (repo-scoped, short TTL).
- [ ] Provision flow: token → clone → RDE → runner → event ingestion (WebSocket or log-stream) → state transitions.
- [ ] PR lifecycle: push branch, open PR (summary + test evidence + task link), record PR ↔ task mapping.
- [ ] Internal REST API: `POST /tasks` (repo, mode, instructions), `GET /tasks/{id}` (state + event log), `POST /tasks/{id}/approve-spec`.
- [ ] Failure paths: provision failure, engine failure, push conflict → `FAILED` with logs retrievable.
- [ ] Package the control plane for **AgentCore Runtime** (linux/arm64 image ≤ 2 GB; session model mapped to task lifecycle), with a plain local-process mode for development.

**Exit criteria:** `curl POST /tasks` against a real test repo results in a real PR on GitHub with passing tests; spec mode works via the approve endpoint; every state transition visible in `GET /tasks/{id}`.

**Deliverables:** control-plane service (state machine + Postgres + queue + worker) · GitHub App with per-task token minting · PR lifecycle (push/open/link) · internal REST API · AgentCore-deployable image + local dev mode · headless demo (curl → real PR).

## Phase 4 — Slack app (the product becomes visible)

- [ ] Slack app manifest, OAuth install flow, workspace ↔ customer ↔ repo-config mapping.
- [ ] Mention handling: `@agent-quick` / `@agent-spec` in a channel/thread → `POST /tasks`; repo resolution from channel config or explicit `repo:` argument.
- [ ] Thread relay: `progress` events → throttled thread updates; `done` → PR link message; `failed` → reason + log snippet.
- [ ] Spec approval UX: spec posted as thread message with **Approve / Revise** buttons; Revise captures free-text feedback and re-plans.
- [ ] `approval_request` UX: allow/deny buttons wired to the runner's blocking gate.
- [ ] Onboarding UX: connect GitHub App, pick repos, per-repo defaults (risk level, test command override).

**Exit criteria:** the README §4 demo works live: tag the bot in Slack → spec → approve → PR link lands in the thread. **This is the MVP milestone.**

**Deliverables:** installable Slack app (manifest + OAuth flow + repo config) · `@agent-quick` and `@agent-spec` flows end-to-end · thread relay (progress/done/failed) · spec Approve/Revise buttons · `approval_request` allow/deny buttons · onboarding flow.

## Phase 5 — Review loop & automerge

- [ ] PR webhook ingestion: reviews, review comments, check-run results.
- [ ] `FIXING_REVIEW` flow: aggregate review feedback → bounded fix invocation ("address these comments on branch X") → push → re-request review; max N rounds then escalate to thread. (Greptile/CodeRabbit surface as ordinary PR reviews/comments, so one ingestion path covers bots and humans.)
- [ ] Risk policy engine: per-repo risk level, per-task override; Low = automerge on green, Medium = Slack merge-approval button, High = stop at READY.
- [ ] Merge + notify; branch cleanup.

**Exit criteria:** a bot review (e.g. CodeRabbit on a test repo) triggers a fix round automatically; a Low-risk task merges itself; a Medium-risk task merges only after the Slack button.

**Deliverables:** PR-webhook ingestion (reviews/comments/checks) · bounded `FIXING_REVIEW` loop with round cap + escalation · risk-policy engine (per-repo level, per-task override) · automerge + merge-approval flow + branch cleanup.

## Phase 6 — Production RDE substrate, pluggability proof, hardening

- [ ] **`FargateProvider`**: CodeBuild prebuild pipeline (`devcontainer build --push` → ECR, per-repo cache, SOCI indexing), runner-layer injection, `postCreate`/`postStart` replay at task start, RunTask/StopTask lifecycle.
- [ ] **`CodeBuildSandboxProvider`**: fallback for compose/DinD devcontainers (`devcontainer up` unmodified in a privileged sandbox); per-repo routing flag + auto-detection of compose/DinD configs.
- [ ] `OpenCodeAdapter` (runner supervises `opencode serve`, translates session events) — the pluggable-interface proof.
- [ ] Conformance matrix across (engine × model × provider); pick per-model defaults from data.
- [ ] Security audit: egress rules, token scopes, prompt-injection review, multi-tenant isolation between customers' RDEs.
- [ ] Observability: structured tracing per task, cost accounting surfaced per workspace, quotas + budget alerts.
- [ ] Concurrency/scale: worker pool sizing, per-workspace concurrency caps, Fargate/CodeBuild quota management.

**Exit criteria:** conformance passes on `FargateProvider` end-to-end (including a first-task prebuild and a cached repeat task); a compose-based fixture routes to and passes on `CodeBuildSandboxProvider`; same task passes on both engines by config switch alone; a documented security review; 10 concurrent tasks run without interference.

**Deliverables:** `FargateProvider` + prebuild pipeline · `CodeBuildSandboxProvider` + routing · `OpenCodeAdapter` · (engine × model × provider) conformance matrix · security-review doc · tracing/cost dashboards + quotas.

---

## Sequencing rationale & risks

- **Engine before sandbox before Slack:** if the engine can't reliably turn tasks into green branches (Phase 1), nothing downstream matters — so it's proven first, on a laptop, where iteration is fast. The sandbox (Phase 2) is the riskiest *infrastructure*; it gets proven before we build product UX on top.
- **Headless before Slack (Phase 3 before 4):** the full pipeline is testable by API long before the UX exists, keeping Slack a thin layer as designed.
- **Biggest schedule risks:** devcontainer build times/flakiness in Phase 2 and the Fargate prebuild pipeline in Phase 6 — first-task latency, `postCreate` replay fidelity, compose/DinD routing (mitigations: ECR per-repo caching, SOCI, CodeBuild Sandbox fallback); review-loop oscillation in Phase 5 (mitigation: hard round cap + escalate early); OpenHands SDK API churn (mitigation: pin versions, conformance suite catches breakage); AgentCore packaging constraints in Phase 3 (arm64, ≤2 GB image, 8 h session caps — mitigation: keep the control plane thin and stateless, state in Postgres).
- **Deferred by design:** GitLab/Bitbucket, deployment-after-merge (README open question), mid-run chat with the agent, pricing/billing.
