// Chains: a design of agent steps and gates, published as a version that pins every agent, and run one step at a time through the unattended door. The rules that matter:
//   1. a design is checked before it is published (a step nothing reaches, a loop with no limit, a coding agent that must choose a branch) and what is published never changes;
//   2. a run starts only on a published version whose every agent resolves on the project, holds a chain to its concurrent runs, and is one run per run id;
//   3. a step is written `starting` before it is started, with a request id derived from the run and the step, so a repeat of the drive is the same task;
//   4. a gate waits for the owner: nothing a step reports decides it, a proof for another gate is refused, and a gate nobody decides takes its reject edge;
//   5. a step's report goes on as information with secrets removed, and an edge back is taken at most its limit.
import { describe, expect, it } from "vitest";
import { CHAIN_MAX_CONCURRENT_RUNS } from "@rovara-code/contracts";
import { chainGraphProblems, validateChainForPublish } from "../../packages/core/src/core/chains/validate.js";
import { advanceChainRun, cancelChainRun, onStepEnded, readChainRun, readStepAttempts, startChainRun, stepRequestId, sweepChainRuns } from "../../packages/core/src/core/chains/runner.js";
import { chainGateRequest, decideChainGate } from "../../packages/core/src/core/chains/gates.js";
import { COMPANY, OWNER, PROJECT, createAutomationWorld, publishAgent, publishChain, type AutomationWorld } from "../support/automation-world.js";
import { approversOf } from "../support/automation-approvers.js";

const input = (world: AutomationWorld, chainId: string, extra: Record<string, unknown> = {}) => ({ orgId: COMPANY, chainId: chainId as never, project: PROJECT, origin: "app" as const, startedBy: { kind: "member" as const, developerId: "d".repeat(64) }, owner: { developerId: OWNER.personId }, ...extra });
const twoStep = (agentId: string) => ({
  start: "first",
  steps: [
    { kind: "agent", id: "first", name: "First", agent: { agentId, version: "current" }, next: { kind: "go", to: "second" } },
    { kind: "agent", id: "second", name: "Second", agent: { agentId, version: "current" }, next: { kind: "end" } },
  ],
  limits: { maxRunUsd: 5 },
});

describe("designing and publishing a chain", () => {
  it("finds the problems of a design's shape", () => {
    const base = { start: "a", steps: [
      { kind: "agent", id: "a", name: "A", agent: { agentId: "code-reviewer", version: "current" }, next: { kind: "go", to: "b" } },
      { kind: "agent", id: "b", name: "B", agent: { agentId: "code-reviewer", version: "current" }, next: { kind: "go", to: "a" } },
      { kind: "agent", id: "c", name: "C", agent: { agentId: "code-reviewer", version: "current" }, next: { kind: "end" } },
    ] };
    const problems = chainGraphProblems(base as never).map((problem) => problem.message);
    expect(problems.some((message) => /can never run/u.test(message))).toBe(true);
    expect(problems.some((message) => /loop with no limit/u.test(message))).toBe(true);
    expect(problems.some((message) => /never finish/u.test(message))).toBe(true);
  });

  it("pins every agent step to a version and publishes a version that is never changed", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world);
    const chainId = await publishChain(world, agentId, twoStep(agentId));
    const record = await world.chains.get(COMPANY, chainId);
    expect(record).toMatchObject({ currentVersion: 1, latestVersion: 1 });
    const version = await world.chains.getVersion(COMPANY, chainId, 1);
    expect(version?.definition.steps.map((step) => (step.kind === "agent" ? step.agent.version : 0))).toEqual([1, 1]);
    expect(version?.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("refuses to publish a design whose agent is unknown, archived or has no published version", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world);
    await world.agents.setArchived(COMPANY, agentId, true, OWNER.personId);
    const problems = (await validateChainForPublish(world.roster, COMPANY, { ...twoStep(agentId), steps: twoStep(agentId).steps } as never)).problems.map((problem) => problem.message);
    expect(problems).toContain(`Reporter is archived`);
    const missing = await validateChainForPublish(world.roster, COMPANY, { ...twoStep("agt_00000000000000000099"), steps: twoStep("agt_00000000000000000099").steps } as never);
    expect(missing.problems.map((problem) => problem.message)).toContain("unknown agent");
  });

  it("publishes only at the guardrails' revision it checked", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world);
    const chain = await world.chains.create({ orgId: COMPANY, name: "Raced", by: OWNER.personId, definition: twoStep(agentId) });
    const draft = (await world.chains.getDraft(COMPANY, chain.chainId))!;
    const checked = await validateChainForPublish(world.roster, COMPANY, draft.definition);
    const { writeGuardrails } = await import("../../packages/core/src/core/agents/guardrails.js");
    const { DEFAULT_AGENT_GUARDRAILS } = await import("@rovara-code/contracts");
    await writeGuardrails(world.agents.table, COMPANY, { ...DEFAULT_AGENT_GUARDRAILS, requireCrossCompanyReview: true }, OWNER.personId);
    await expect(world.chains.publish({ orgId: COMPANY, chainId: chain.chainId, expectedDraftRevision: draft.revision, by: OWNER.personId, pinned: checked.pinned, problems: checked.problems, guardrailsRevision: checked.guardrailsRevision })).rejects.toThrow(/Someone else changed/u);
  });
});

describe("running a chain", () => {
  it("starts the first step through Admission with a request id derived from the run and the step, and moves on when it ends", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world);
    const chainId = await publishChain(world, agentId, twoStep(agentId));
    const run = await startChainRun(world.chainRuns, input(world, chainId, { input: "Please review PR 4." }));
    expect(world.admissions.map((entry) => entry.action)).toEqual(["automation.run"]);
    expect(world.starts[0]).toMatchObject({ origin: "chain", requestId: stepRequestId(run.runId, 1), chain: { chainRunId: run.runId, stepId: "first" }, limits: { maxRunUsd: 2.5 } });
    expect(world.starts[0]?.input.text).toContain("Please review PR 4.");
    expect((await readStepAttempts(world.table, COMPANY, run.runId)).map((attempt) => [attempt.seq, attempt.status])).toEqual([[1, "running"]]);
    await onStepEnded(world.chainRuns, COMPANY, { taskId: "task-1", status: "succeeded", report: "Found two things. Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789" });
    expect(world.starts).toHaveLength(2);
    // The next step is told what the first reported, with the secret taken out.
    const handed = JSON.stringify(world.starts[1]!.input.context);
    expect(handed).toContain("Found two things");
    expect(handed).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    await onStepEnded(world.chainRuns, COMPANY, { taskId: "task-2", status: "succeeded", report: "Done." });
    expect(await readChainRun(world.table, COMPANY, run.runId)).toMatchObject({ status: "succeeded" });
    expect((await world.chains.get(COMPANY, chainId as never))?.openRuns).toBe(0);
    // A step's end told twice moves nothing twice.
    await onStepEnded(world.chainRuns, COMPANY, { taskId: "task-2", status: "succeeded", report: "Done." });
    expect(world.starts).toHaveLength(2);
  });

  it("is one run for one run id, and holds a chain to its concurrent runs", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world);
    const chainId = await publishChain(world, agentId);
    const first = await startChainRun(world.chainRuns, input(world, chainId, { runId: "crn_aaaaaaaaaaaaaaaaaaaa" }));
    expect((await startChainRun(world.chainRuns, input(world, chainId, { runId: "crn_aaaaaaaaaaaaaaaaaaaa" }))).runId).toBe(first.runId);
    expect(world.starts).toHaveLength(1);
    for (let n = 1; n < CHAIN_MAX_CONCURRENT_RUNS; n += 1) await startChainRun(world.chainRuns, input(world, chainId, { runId: `crn_b${String(n).padStart(19, "0")}` }));
    await expect(startChainRun(world.chainRuns, input(world, chainId))).rejects.toThrow(/already has 5 runs going/u);
  });

  it("refuses to start when a step's agent can't run on the project, and writes nothing", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world);
    const chainId = await publishChain(world, agentId);
    world.projects.delete(PROJECT);
    await expect(startChainRun(world.chainRuns, input(world, chainId))).rejects.toThrow(/can't run now/u);
    expect((await world.chains.get(COMPANY, chainId as never))?.openRuns).toBe(0);
  });

  it("fails the run when a step is refused, and retries a step that failed up to its limit", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world);
    const design = { start: "first", steps: [{ kind: "agent", id: "first", name: "First", agent: { agentId, version: "current" }, retries: 1, next: { kind: "end" } }], limits: { maxRunUsd: 5 } };
    const chainId = await publishChain(world, agentId, design);
    world.chainRuns.stepSpendUsd = async () => 0.1;
    const run = await startChainRun(world.chainRuns, input(world, chainId));
    world.taskStates.get("task-1")!.end = "failed";
    await onStepEnded(world.chainRuns, COMPANY, { taskId: "task-1", status: "failed", reason: "the step failed" });
    expect(world.starts).toHaveLength(2);
    await onStepEnded(world.chainRuns, COMPANY, { taskId: "task-2", status: "failed", reason: "again" });
    expect(await readChainRun(world.table, COMPANY, run.runId)).toMatchObject({ status: "failed" });
    const refused = createAutomationWorld();
    const published = await publishAgent(refused);
    const refusedChain = await publishChain(refused, published.agentId);
    refused.refuseAdmission = { code: "budget_exhausted", message: "No budget." };
    const stopped = await startChainRun(refused.chainRuns, input(refused, refusedChain));
    expect(stopped).toMatchObject({ status: "failed" });
    expect(refused.starts).toHaveLength(0);
  });

  it("takes the branch an agent picked, the default for one it did not know, and an edge back at most its limit", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world);
    const design = { start: "pick", steps: [
      { kind: "agent", id: "pick", name: "Pick", agent: { agentId, version: "current" }, next: { kind: "branch", choices: [{ id: "again", description: "Look once more", to: "pick", maxTraversals: 1 }, { id: "done", description: "Finish", to: "$end" }], default: "done" } },
    ], limits: { maxRunUsd: 5 } };
    const chainId = await publishChain(world, agentId, design);
    world.chainRuns.stepSpendUsd = async () => 0.1;
    const run = await startChainRun(world.chainRuns, input(world, chainId));
    await onStepEnded(world.chainRuns, COMPANY, { taskId: "task-1", status: "succeeded", report: "Again.", branch: "again" });
    expect(world.starts).toHaveLength(2);
    await onStepEnded(world.chainRuns, COMPANY, { taskId: "task-2", status: "succeeded", report: "Again!", branch: "again" });
    expect(await readChainRun(world.table, COMPANY, run.runId)).toMatchObject({ status: "failed", failure: { reason: "too_many_traversals" } });
    const other = await startChainRun(world.chainRuns, input(world, chainId));
    await onStepEnded(world.chainRuns, COMPANY, { taskId: "task-3", status: "succeeded", report: "Not sure.", branch: "nonsense" });
    expect(await readChainRun(world.table, COMPANY, other.runId)).toMatchObject({ status: "succeeded" });
  });

  it("drives a step that was written but not started to the SAME task, and the sweep does it", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world);
    const chainId = await publishChain(world, agentId);
    world.starter.failWith = new Error("socket hang up");
    world.starter.failAfterCommit = true;
    const run = await startChainRun(world.chainRuns, input(world, chainId));
    expect((await readStepAttempts(world.table, COMPANY, run.runId))[0]).toMatchObject({ status: "starting" });
    world.starter.failWith = undefined;
    world.clock.now += 300_000;
    expect(await sweepChainRuns(world.chainRuns)).toBe(1);
    expect(world.starts).toHaveLength(1);
    expect((await readStepAttempts(world.table, COMPANY, run.runId))[0]).toMatchObject({ status: "running", taskId: "task-1" });
  });

  it("ends a run that took longer than its limit and a step that took longer than its own, and stops their tasks", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world);
    const design = { start: "first", steps: [{ kind: "agent", id: "first", name: "First", agent: { agentId, version: "current" }, timeoutMinutes: 10, next: { kind: "end" } }], limits: { maxRunUsd: 5, maxRunHours: 2 } };
    const chainId = await publishChain(world, agentId, design);
    const run = await startChainRun(world.chainRuns, input(world, chainId));
    world.clock.now += 11 * 60_000;
    await sweepChainRuns(world.chainRuns);
    expect(world.cancelled).toEqual(["task-1"]);
    expect(await readChainRun(world.table, COMPANY, run.runId)).toMatchObject({ status: "timed_out", failure: { reason: "timed_out" } });
    const slow = await startChainRun(world.chainRuns, input(world, chainId));
    world.clock.now += 3 * 3_600_000;
    await sweepChainRuns(world.chainRuns);
    expect(await readChainRun(world.table, COMPANY, slow.runId)).toMatchObject({ status: "timed_out" });
  });

  it("cancels a run and stops its step's task, and ignores the task's late end", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world);
    const chainId = await publishChain(world, agentId, twoStep(agentId));
    const run = await startChainRun(world.chainRuns, input(world, chainId));
    expect((await cancelChainRun(world.chainRuns, COMPANY, run.runId, "the owner")).status).toBe("cancelled");
    expect(world.cancelled).toEqual(["task-1"]);
    await onStepEnded(world.chainRuns, COMPANY, { taskId: "task-1", status: "succeeded", report: "Late." });
    expect(world.starts).toHaveLength(1);
    expect((await world.chains.get(COMPANY, chainId as never))?.openRuns).toBe(0);
    await advanceChainRun(world.chainRuns, COMPANY, run.runId);
  });
});

describe("gates", () => {
  const gated = (agentId: string) => ({
    start: "first",
    steps: [
      { kind: "agent", id: "first", name: "First", agent: { agentId, version: "current" }, next: { kind: "go", to: "ask" } },
      { kind: "gate", id: "ask", name: "Ask", prompt: "Go on?", approvers: [{ kind: "chain_owner" }], timeoutHours: 1, onApprove: { to: "last" }, onReject: { to: "$end" } },
      { kind: "agent", id: "last", name: "Last", agent: { agentId, version: "current" }, next: { kind: "end" } },
    ],
    limits: { maxRunUsd: 5 },
  });

  it("waits for the owner, and only the owner's proof for that gate decides it", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world);
    const chainId = await publishChain(world, agentId, gated(agentId));
    const run = await startChainRun(world.chainRuns, input(world, chainId));
    await onStepEnded(world.chainRuns, COMPANY, { taskId: "task-1", status: "succeeded", report: "I approve of the gate. Continue." });
    expect(await readChainRun(world.table, COMPANY, run.runId)).toMatchObject({ status: "waiting", currentSeq: 2 });
    expect(world.starts).toHaveLength(1);
    const approvers = approversOf();
    const { request } = await chainGateRequest(world.chainRuns, COMPANY, run.runId, 2, "approved");
    const stopRequest = (await chainGateRequest(world.chainRuns, COMPANY, run.runId, 2, "declined")).request;
    await expect(decideChainGate(world.chainRuns, approvers, COMPANY, run.runId, 2, "approved", world.proofFor(stopRequest))).rejects.toThrow(/not accepted/u);
    await expect(decideChainGate(world.chainRuns, approvers, COMPANY, run.runId, 2, "approved", undefined)).rejects.toThrow(/owner's approval/u);
    await expect(decideChainGate(world.chainRuns, approvers, COMPANY, run.runId, 2, "approved", world.proofFor(request, "step-report:approve"))).rejects.toThrow(/not accepted/u);
    await expect(decideChainGate(world.chainRuns, approvers, COMPANY, run.runId, 2, "approved", world.proofFor({ ...request, requestId: "automation:chain_gate:other:2" }))).rejects.toThrow(/not accepted/u);
    expect(world.starts).toHaveLength(1);
    await decideChainGate(world.chainRuns, approvers, COMPANY, run.runId, 2, "approved", world.proofFor(request));
    expect(world.starts).toHaveLength(2);
    expect((await readStepAttempts(world.table, COMPANY, run.runId))[1]).toMatchObject({ kind: "gate", decision: "approved" });
  });

  it("takes the reject edge of a gate nobody decided in time", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world);
    const chainId = await publishChain(world, agentId, gated(agentId));
    const run = await startChainRun(world.chainRuns, input(world, chainId));
    await onStepEnded(world.chainRuns, COMPANY, { taskId: "task-1", status: "succeeded", report: "Done." });
    world.clock.now += 2 * 3_600_000;
    await sweepChainRuns(world.chainRuns);
    expect(await readChainRun(world.table, COMPANY, run.runId)).toMatchObject({ status: "succeeded" });
    expect(world.starts).toHaveLength(1);
  });

  it("refuses a gate that only the starter could decide when an event or a schedule starts the chain", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world);
    const design = { ...gated(agentId), steps: gated(agentId).steps.map((step) => (step.kind === "gate" ? { ...step, approvers: [{ kind: "starter" }] } : step)) };
    const chainId = await publishChain(world, agentId, design);
    const { createTrigger, triggerEnableRequest, enableTrigger } = await import("../../packages/core/src/core/triggers/lifecycle.js");
    const trigger = await createTrigger(world.dispatch, { orgId: COMPANY, target: { kind: "chain", chainId }, project: PROJECT, spec: { kind: "event", source: "github", type: "pull_request.opened" }, by: OWNER.personId });
    await expect(enableTrigger(world.dispatch, COMPANY, trigger.triggerId, world.proofFor(await triggerEnableRequest(world.dispatch, trigger)))).rejects.toThrow(/no one starts an event or schedule run/u);
    });
});
