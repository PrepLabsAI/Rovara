# AgentX Architecture

Companion to [README.md](README.md) (requirements). This doc describes the system design in depth: the layers, the task lifecycle, the engine interface, and the reasoning behind each boundary.

```
Slack workspace
   │  @agent-quick / @agent-spec (events via Slack app)
   ▼
Control plane  ──  task queue + state machine, repo/token management,
   │               spec approval, PR lifecycle, review loop, automerge
   ▼  provisions per task
RDE (devcontainer sandbox)
   └─ agentx-runner   ← the only component that knows which engine is used
        └─ EngineAdapter → OpenHands SDK │ opencode serve │ (optional) Claude Agent SDK
```

## 1. The four layers

**Layer 1 — Slack app (the interface).** A thin edge: receives mention events from Slack's Events API, resolves workspace → customer → repo config, posts messages/buttons back into threads. Holds no business logic — it translates between Slack's world (events, blocks, threads) and the control plane's world (tasks, states). Kept thin because Slack is the *first* interface, not necessarily the only one (GitHub issue comments, a web dashboard, Linear could become task sources later); each should be a new edge, not a fork of the core.

**Layer 2 — Control plane (the brain).** The durable heart of the product and the only stateful service. Owns:

- the task queue and state machine (§3),
- repo access: minting short-lived GitHub App installation tokens per task,
- RDE lifecycle: provision sandbox → inject workspace + token → tear down,
- spec approval: holding a task while a spec awaits a Slack decision,
- PR lifecycle: push branch, open PR, watch reviews, drive the fix loop, automerge per risk policy,
- accounting: token/cost tracking per task and workspace quotas.

Everything here is engine- and model-agnostic by construction — it only ever sees the normalized event stream (§4).

**Layer 3 — RDE (the sandbox).** One ephemeral devcontainer-based environment per task. It exists because we run untrusted code twice over: the customer's repo (their tests, their `postCreateCommand`) *and* whatever the LLM writes. The RDE is the blast-radius wall — network egress controls, resource caps, hard timeout, no long-lived secrets.

**Layer 4 — `agentx-runner` + adapter (the engine seam).** The runner is a small supervisor process that is the entrypoint of the RDE. It reads a `TaskSpec`, instantiates the configured `EngineAdapter`, runs it, and relays normalized events upward. It is the only code in the system that imports an engine SDK.

**Why the boundaries sit here:** each line separates things that change at different speeds. Slack API churn stays in layer 1; product logic (approval flows, risk policies) in layer 2; sandbox tech (Firecracker vs Docker) in layer 3; engine/model churn — the fastest-moving part of this stack — in layer 4. A component only needs redeploying when *its* world changes.

## 2. Life of a task (spec mode, full path)

```
User: "@agent-spec add rate limiting to the /login endpoint"
  │
  1. Slack app → control plane: create Task{repo, mode=spec, instructions, thread_id}
  2. Control plane: ack in thread, enqueue
  3. Worker picks up task:
       a. mint installation token (scoped to this repo, ~1h TTL)
       b. provision RDE, clone repo at default branch, run devcontainer setup
       c. launch agentx-runner with TaskSpec{mode:"spec", instructions}
  4. Engine explores the repo (possibly fanning out read-only subagents),
     emits {type:"spec", markdown} → posted to thread with Approve/Revise
     buttons. RDE is torn down or paused.
  5. Task parks in AWAITING_SPEC_APPROVAL. (Revisions re-run steps 3–4 with
     the feedback appended.)
  6. On Approve: fresh invocation — TaskSpec{mode:"spec", approvedSpec,
     instructions}. Engine implements, runs tests, iterates until green,
     commits to a branch. Emits progress along the way and finally
     {type:"done", result:{branch, summary, testEvidence}}.
  7. Control plane (not the engine): pushes the branch, opens the PR with
     summary + test evidence + Slack thread link, posts the PR link.
  8. Review loop: Greptile/CodeRabbit/human comments arrive via webhook.
     Control plane spins up a new bounded engine invocation: "address these
     review comments on branch X". Repeat up to N rounds, then escalate.
  9. Checks green + review passed → risk policy:
     Low → merge + notify. Medium → Slack approval button → merge.
     High → stop at "PR ready".
```

`@agent-quick` is the same pipeline minus steps 4–5.

**Two structural properties of this flow:**

- **Every engine invocation is stateless and bounded.** Plan, implement, and each review-fix round are separate runs with explicit inputs. Continuity lives in *artifacts* (the spec text, the branch, review comments), not long-lived engine sessions. This makes the system resumable after crashes, cheap during human waits (no idle sandbox while a spec awaits approval for two days), and portable across engines — "resume my session" is the least standardized engine capability; "start fresh from these inputs" works everywhere.
- **The Slack thread is the audit log.** Every state transition produces a thread message, so the user's view and the system's history are the same thing.

## 3. The task state machine

Persisted per task in the control plane:

```
QUEUED → PROVISIONING → PLANNING → AWAITING_SPEC_APPROVAL → IMPLEMENTING
   (quick mode skips the middle two)      ↑______revise______|
IMPLEMENTING → PR_OPEN → IN_REVIEW ⇄ FIXING_REVIEW → READY
READY → AWAITING_MERGE_APPROVAL → MERGED   (per risk level)
any state → FAILED(reason) → posted to thread with logs
```

Explicit states (rather than a long-running process) let tasks survive control-plane restarts, let humans take days to approve, and give natural metric hooks ("time in IN_REVIEW", "revision rate per repo").

## 4. The engine interface and event protocol

### The `AgentEngine` contract

```ts
interface AgentEngine {
  runTask(task: TaskSpec, ws: Workspace): AsyncIterable<EngineEvent>;
  cancel(taskId: string): Promise<void>;
}

interface TaskSpec {
  mode: "quick" | "spec";        // spec mode = produce a plan first, then wait
  instructions: string;           // the user's Slack message + thread context
  approvedSpec?: string;          // present on the resume run in spec mode
  constraints: { maxTokens?: number; timeoutSec: number; model?: string };
  engineConfig?: Record<string, unknown>;  // opaque per-engine passthrough
}

type EngineEvent =
  | { type: "progress"; text: string }                       // relayed to thread
  | { type: "spec"; markdown: string }                       // plan for approval
  | { type: "approval_request"; id: string; action: string } // risky-action gate
  | { type: "usage"; tokens: number; costUsd: number }
  | { type: "done"; result: TaskResult }
  | { type: "failed"; reason: string; log: string };

interface TaskResult {
  branch: string;                 // engine committed here; control plane pushes + opens PR
  summary: string;                // becomes the PR description
  testEvidence: string;           // test command + output
}
```

Deliberate choices: the **engine ends at a local branch** (credentials never need to be engine-visible; PR formatting is uniform), and **spec mode is two invocations** (the interface never needs mid-run bidirectional chat — the least portable feature across engines).

### Adapters

- **OpenHandsAdapter** — in-process: build a `Conversation` with the LiteLLM model string from `constraints.model`, register terminal/file tools, map its event callbacks to `EngineEvent`s.
- **OpenCodeAdapter** — process supervisor: start `opencode serve` in the workspace, create a session via `@opencode-ai/sdk`, send the prompt, translate session events; map its permission-request API to `approval_request`.
- **ClaudeAgentSDKAdapter** — wrap `query(prompt, options)`; keeps Claude-native available for customers who want the best-tuned Claude harness, without making it a dependency.

Adapters stay small because the contract is coarse — mostly event translation plus lifecycle plumbing. Per-engine prompt tuning (house rules, "run tests before finishing", commit conventions) lives in the adapter; task instructions stay engine-neutral.

### The event protocol

Runner → control plane is deliberately dumb: newline-delimited JSON over a single stream (WebSocket or queue). Purpose of each event type:

- **`progress`** — the UX heartbeat. Engines narrate differently; the adapter's biggest job is throttling and translating this into occasional human-readable thread updates rather than a firehose.
- **`spec`** — the one structured deliverable besides the final result. Plain markdown; the control plane renders it, never parses it.
- **`approval_request`** — the escape hatch for mid-run gates ("engine wants to run a DB migration"). The runner blocks the engine (via each engine's permission-callback mechanism) until the control plane replies allow/deny — surfaced as Slack buttons. The only bidirectional interaction, and it's request/response, not chat.
- **`usage`** — token/cost accounting flows through the same pipe so billing needs no engine integration.
- **`done` / `failed`** — terminal. `failed` carries a reason plus the log tail, posted to the thread verbatim — honest failure reporting is a feature.

Protocol discipline: **adding an event type requires every adapter to handle it**, so the bar stays high and engine-specific richness gets flattened into `progress` rather than leaking upward.

## 5. Security and credential flow

The load-bearing property: **the engine (and thus the LLM) never holds a durable credential.**

- The GitHub App private key lives only in the control plane. Per task it mints a short-lived, single-repo installation token.
- The token is used by the *provisioner* to clone (before the engine starts) and by the *control plane* to push/open the PR (after the engine exits). During the engine's run, ideally no token is in the sandbox; if mid-run fetches are needed, expose the token via a git credential helper scoped read-only.
- LLM API keys sit in the runner's environment, injected at launch, never in the repo workspace. RDE egress allowlists the model provider + package registries — which also caps prompt-injection blast radius (a malicious `CONTRIBUTING.md` telling the agent to exfiltrate secrets has nothing to exfiltrate and nowhere to send it).
- Because the control plane opens the PR, an engine gone haywire can at worst make a mess on a branch in a sandbox — it cannot merge, push to main, or touch another repo.

## 6. Why the interface is coarse ("task in → branch out")

1. **Abstractions leak in proportion to their surface area.** A fine-grained interface (expose the loop, tool calls, subagent APIs) would force every engine's internals into a common shape — and internals are exactly where engines disagree. OpenHands' `DelegateTool`, OpenCode's session forking, and Claude Code's `Agent` tool are conceptually similar but API-incompatible. At the task level they're identical: all take instructions and produce a branch.
2. **The interface encodes our product, not their tech.** `TaskSpec` and `TaskResult` fields come straight from the requirements doc, so the contract changes only when the *product* changes — the correct coupling direction.
3. **It makes engines measurable.** Because every engine is invoked identically and judged on identical outputs, the conformance suite doubles as an eval harness: run golden tasks across (engine × model) pairs, score PR correctness / test pass rate / cost / latency, and let data pick the default engine per model tier.

Known cost of coarseness: no deep mid-run collaboration (user chatting with the agent turn-by-turn while it works). If that becomes a requirement it's a v2 protocol extension — a `message` event flowing downward — and will be the most engine-uneven feature we build. Deliberately deferred.

Guardrails against interface rot:

- **Lowest-common-denominator trap:** don't grow a method per engine feature. Engine-specific capabilities pass through the opaque `engineConfig` blob, not the typed contract.
- **Behavioral drift:** an interface guarantees shape, not quality — hence the conformance suite (§7).

## 7. Conformance suite

A repo of ~10–20 fixture projects, each with a task and an oracle:

- a project with a failing test → oracle: test passes on the produced branch;
- a project needing a small feature → oracle: hidden acceptance tests pass;
- a task with a deliberate ambiguity → oracle: spec mode surfaces the right question.

CI runs each fixture through each adapter with a pinned model, applies the oracles, and reports a matrix. It is the safety net for three changes that otherwise fail silently by producing subtly worse PRs: engine version bumps, adapter refactors, and prompt tuning.

## 8. Where the hard engineering is (risk-ranked)

1. **RDE infrastructure** — running arbitrary devcontainers securely and fast at scale; the sandbox-substrate question (microVMs vs gVisor vs Docker-on-K8s) is still open.
2. **The review-fix loop** — parsing heterogeneous review feedback (Greptile vs CodeRabbit vs humans) into bounded fix tasks without oscillating.
3. **Event-stream UX** — making the Slack thread informative without being spammy.
4. **The engine adapters** — genuinely the easy part, which is the sign the boundary is drawn right.
