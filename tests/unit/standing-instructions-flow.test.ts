// Standing instructions on the task flow: the company's rules and the project's How we work are put in front of every step that reads them, read at the dispatch, never dropped and never cut.
import { describe, expect, it } from "vitest";
import {
  COMPANY_RULES_EXCEED_BUDGET_MESSAGE, PLAYBOOK_FILE_PATH, change, projectPlaybookKey, STANDING_INSTRUCTIONS_FEATURE, WORKER_INVOCATION_FEATURES, WorkerInvocationSchema, agentXError, queryAll,
  type CompanyInstructionsSnapshot, type WorkerInvocation,
} from "@agentx/contracts";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { createStandingInstructions, STANDING_BLOCK_TOO_LONG } from "../../packages/broker/src/core/instructions/step-block.js";
import { COULD_NOT_READ_RULES, createPlaybookService } from "../../packages/broker/src/core/playbook/service.js";
import { createCodeHostPlaybookSource } from "../../packages/broker/src/core/playbook/source.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import type { OperationRecord, WorkspaceRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { COMPANY, createHarness, definition, newRequestId, type Harness } from "../support/task-flow-harness.js";
import { fakeCompanyInstructionsSource } from "../support/company-instructions-fake.js";

const URL_ = "https://examplehost.test/acme/app";
const RULES: CompanyInstructionsSnapshot = { version: "3", rules: [{ text: "Never log customer data.", priority: "required" }, { text: "Use integer cents.", priority: "preferred" }] };
const FILE = "version: 1\nrules: PROJECT-RULE ticket id.\nstages:\n  plan:\n    instructions: PLAN-RULE\n";

async function setup(options: { file?: string; company?: Parameters<typeof fakeCompanyInstructionsSource>[0] | undefined; features?: string[] } = {}) {
  const h = createHarness({ understandFirst: true, machines: { features: options.features ?? [...WORKER_INVOCATION_FEATURES] } });
  const project = { ...definition, repositories: [{ ...definition.repositories[0]!, url: URL_, host: { kind: "fake" } }] } as typeof definition;
  await h.registerProject(project);
  const model = new FakeHostModel({ url: URL_, id: "1", fullName: "acme/app", initialFiles: options.file === undefined ? { "README.md": "x" } : { "README.md": "x", [PLAYBOOK_FILE_PATH]: options.file } });
  const host = new FakeCodeHost(model);
  const registry = createAdapterRegistry();
  registry.register("code-host", "fake", host);
  const playbook = createPlaybookService({
    companyId: COMPANY, store: h.store, audit: h.deps.audit, projects: h.deps.projects, now: h.deps.now ?? (() => new Date()),
    source: createCodeHostPlaybookSource({ companyId: COMPANY, projects: h.deps.projects, codeHosts: registry, now: () => h.clock.now }),
  });
  const company = options.company === undefined ? undefined : fakeCompanyInstructionsSource(options.company);
  h.deps.standingInstructions = createStandingInstructions({ companyId: COMPANY, playbook, ...(company === undefined ? {} : { company }) });
  return { h, model, host, company };
}

async function operationsOf(h: Harness, workspaceId: string): Promise<OperationRecord[]> {
  const items = await queryAll(h.store, { pk: workspaceKey(workspaceId).pk, sk: { op: "beginsWith", prefix: "OPERATION#" } });
  return items.map((item) => item as unknown as OperationRecord).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.fence - b.fence);
}

async function drain(h: Harness, rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    const report = await h.flow.dispatchOnce({ maxMessages: 10 });
    if (report.received === 0) return;
    h.clock.advance(70);
  }
}

/**
 * Starts a task, prepares its workspace and returns where Understand is. `unpinned`: the task starts with no rules source (so it pins no playbook commit, as a task from before pinning), and the source is put back
 * for its steps: the way to meet the dispatch's own reads of the rules.
 */
async function startedAndPrepared(h: Harness, options: { unpinned?: boolean } = {}) {
  const seam = h.deps.standingInstructions;
  if (options.unpinned === true) delete h.deps.standingInstructions;
  const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Add a /health endpoint", workflow: true }).finally(() => { if (seam !== undefined) h.deps.standingInstructions = seam; });
  await drain(h);
  const workspace = (await h.store.get(workspaceKey(started.task.workspaceId))) as unknown as WorkspaceRecord;
  const machineId = workspace.machine!.machineId;
  const prepare = h.machines.delivered(machineId).at(-1)!;
  h.machines.finish(machineId, prepare.operationId);
  await h.flow.recordResult({ workspaceId: workspace.id, operationId: prepare.operationId, fence: 1, status: "SUCCEEDED", outcome: { kind: "prepared" } });
  return { started, workspace, machineId };
}
const lastTask = (h: Harness, machineId: string): WorkerInvocation | undefined => h.machines.delivered(machineId).filter((entry) => entry.kind === "task").at(-1);
const standingOf = (invocation: WorkerInvocation | undefined): { text: string; company?: { version: string; text: string } } | undefined =>
  (invocation as { payload?: { standingInstructions?: { text: string; company?: { version: string; text: string } } } } | undefined)?.payload?.standingInstructions;

describe("the block on a dispatched step", () => {
  it("Understand carries the company's rules and the project's How we work, in order, in a payload the worker accepts; the preparation carries none", async () => {
    const { h } = await setup({ file: FILE, company: [RULES] });
    const { workspace, machineId } = await startedAndPrepared(h);
    expect(standingOf(h.machines.delivered(machineId)[0])).toBeUndefined();
    await drain(h);
    const understand = lastTask(h, machineId)!;
    expect(WorkerInvocationSchema.safeParse(understand).success).toBe(true);
    const block = standingOf(understand)!;
    expect(block.text.indexOf("Company rules")).toBeLessThan(block.text.indexOf("How we work"));
    expect(block.text).toContain("- Never log customer data.");
    expect(block.text).toContain("From .rovara/playbook.yaml:\n> PROJECT-RULE ticket id.");
    expect(block.text).toContain("> PLAN-RULE");
    expect(block.company?.version).toBe("3");
    expect(block.company?.text).not.toContain("PROJECT-RULE");
    expect(workspace.id).toBeDefined();
  });

  it("no rules and no file: no block, and the step is exactly what it was before", async () => {
    const { h } = await setup();
    const { machineId } = await startedAndPrepared(h);
    await drain(h);
    const understand = lastTask(h, machineId)!;
    expect(understand).toMatchObject({ kind: "task", payload: { workflowMode: "UNDERSTAND" } });
    expect(standingOf(understand)).toBeUndefined();
  });

  it("reads the newest rules at each step: a rule file changed between two steps is in the second", async () => {
    const { h, company } = await setup({ company: [RULES, { version: "4", rules: [{ text: "Brand new rule.", priority: "required" }] }] });
    expect(company?.asked).toEqual([]);
    const { workspace, machineId } = await startedAndPrepared(h);
    await drain(h);
    const understand = lastTask(h, machineId)!;
    expect(standingOf(understand)?.company?.version).toBe("3");
    h.machines.finish(machineId, understand.operationId);
    await h.flow.recordResult({ workspaceId: workspace.id, operationId: understand.operationId, fence: 2, status: "SUCCEEDED", outcome: { kind: "understood", assessment: { kind: "ready", path: "QUICK", restatement: "Add a health endpoint", assumptions: [] } } });
    await drain(h);
    const plan = lastTask(h, machineId)!;
    expect(plan).toMatchObject({ payload: { workflowMode: "PLAN" } });
    expect(standingOf(plan)?.company?.version).toBe("4");
    expect(standingOf(plan)?.text).toContain("Brand new rule.");
  });

  it("a worker that cannot place the block is refused the step, never sent it without", async () => {
    const { h } = await setup({ company: [RULES], features: WORKER_INVOCATION_FEATURES.filter((feature) => feature !== STANDING_INSTRUCTIONS_FEATURE) });
    const { workspace, machineId } = await startedAndPrepared(h);
    await drain(h);
    const operations = await operationsOf(h, workspace.id);
    expect(operations.at(-1)).toMatchObject({ kind: "task", status: "FAILED", error: "this worker is too old to run this step; upgrade it" });
    expect(lastTask(h, machineId)).toBeUndefined();
  });

  it("a worker that cannot place the block is fine when there is no block", async () => {
    const { h } = await setup({ features: WORKER_INVOCATION_FEATURES.filter((feature) => feature !== STANDING_INSTRUCTIONS_FEATURE) });
    const { machineId } = await startedAndPrepared(h);
    await drain(h);
    expect(lastTask(h, machineId)).toBeDefined();
  });
});

describe("failing closed", () => {
  it("a file that cannot be used ends the step with its sentence, and nothing is sent to the worker", async () => {
    const { h } = await setup({ file: "version: 1\nstages:\n  check:\n    instructions: x" });
    const { workspace, machineId } = await startedAndPrepared(h, { unpinned: true });
    await drain(h);
    const last = (await operationsOf(h, workspace.id)).at(-1)!;
    expect(last).toMatchObject({ kind: "task", status: "FAILED" });
    expect(last.error).toContain("This project's How we work file can't be used right now (stages.check: Rules for this stage aren't used yet.)");
    expect(lastTask(h, machineId)).toBeUndefined();
  });

  it("company rules over the limits end the step with the clear sentence, nothing cut", async () => {
    const tooMany: CompanyInstructionsSnapshot = { version: "9", rules: Array.from({ length: 31 }, () => ({ text: "x", priority: "required" as const })) };
    const { h } = await setup({ company: [tooMany] });
    const { workspace } = await startedAndPrepared(h);
    await drain(h);
    expect((await operationsOf(h, workspace.id)).at(-1)?.error).toContain(COMPANY_RULES_EXCEED_BUDGET_MESSAGE);
  });

  it("a rule source that fails, or a code host that does not answer, makes the step wait and try again; it ends nothing", async () => {
    const down = await setup({ company: new Error("store down") });
    const first = await startedAndPrepared(down.h);
    await drain(down.h, 3);
    const operations = await operationsOf(down.h, first.workspace.id);
    expect(operations.at(-1)).toMatchObject({ kind: "task" });
    expect(["FAILED", "SUCCEEDED"]).not.toContain(operations.at(-1)?.status);
    expect(lastTask(down.h, first.machineId)).toBeUndefined();

    const hostDown = await setup({ file: FILE });
    hostDown.host.baseBranchHead = () => Promise.reject(agentXError("RUNTIME_UNAVAILABLE", "down"));
    const second = await startedAndPrepared(hostDown.h, { unpinned: true });
    await drain(hostDown.h, 3);
    expect((await operationsOf(hostDown.h, second.workspace.id)).at(-1)?.status).not.toBe("FAILED");
    expect(lastTask(hostDown.h, second.machineId)).toBeUndefined();
    // The host answers again: the step goes.
    hostDown.host.baseBranchHead = (_repository, branch) => Promise.resolve(hostDown.model.headOf(branch));
    hostDown.h.clock.advance(200);
    await drain(hostDown.h);
    expect(standingOf(lastTask(hostDown.h, second.machineId))?.text).toContain("PROJECT-RULE");
  });
});

describe("the rules are read first, and the true cause is said", () => {
  it("a code host that stays down ends the step after the bounded tries with the true cause, never 'the machine did not become ready'", async () => {
    const { h, host } = await setup({ file: FILE });
    host.baseBranchHead = () => Promise.reject(agentXError("RUNTIME_UNAVAILABLE", "down"));
    const { workspace, machineId } = await startedAndPrepared(h, { unpinned: true });
    await drain(h, 60);
    const last = (await operationsOf(h, workspace.id)).at(-1)!;
    expect(last).toMatchObject({ kind: "task", status: "FAILED" });
    expect(last.error).toContain(COULD_NOT_READ_RULES);
    expect(last.error).not.toContain("did not become ready");
    expect(lastTask(h, machineId)).toBeUndefined();
  });

  it("asks nothing of admission and starts no machine for a step whose rules cannot be read or cannot be used", async () => {
    for (const mode of ["outage", "invalid"] as const) {
      const { h, host } = await setup({ file: mode === "invalid" ? "version: 1\nstages:\n  check:\n    instructions: x" : FILE });
      const { workspace } = await startedAndPrepared(h, { unpinned: true });
      // The machine of the workspace is gone (reaped): the next step would have to ask for one.
      await h.store.update({ key: workspaceKey(workspace.id), ops: [change.remove("machine")] });
      if (mode === "outage") host.baseBranchHead = () => Promise.reject(agentXError("RUNTIME_UNAVAILABLE", "down"));
      const asked: string[] = [];
      const original = h.deps.admission;
      h.deps.admission = new Proxy(original, { get: (target, key) => (key === "stage" ? (request: { action: string }) => { asked.push(request.action); return target.stage(request as never); } : Reflect.get(target, key) as unknown) });
      let started = 0;
      const startMachine = h.machines.start.bind(h.machines);
      h.machines.start = (request) => { started += 1; return startMachine(request); };
      await drain(h, 4);
      expect(asked, mode).toEqual([]);
      expect(started, mode).toBe(0);
    }
  });
});

describe("a task starts under one playbook", () => {
  it("pins the commit the playbook was read at when the task starts, and keeps it on the workspace", async () => {
    const { h, model } = await setup({ file: FILE });
    const { workspace } = await startedAndPrepared(h);
    expect(workspace.playbookCommit).toBe(model.headOf("main"));
  });

  it("reads the pinned commit at every step: a file merged after the start does not reach the task, and a later task gets it", async () => {
    const { h, model } = await setup({ file: "version: 1\nrules: RULES-ONE" });
    const first = await startedAndPrepared(h);
    model.commit("main", { [PLAYBOOK_FILE_PATH]: "version: 1\nrules: RULES-TWO" });
    h.clock.advance(60);
    await drain(h);
    expect(standingOf(lastTask(h, first.machineId))?.text).toContain("RULES-ONE");
    expect(standingOf(lastTask(h, first.machineId))?.text).not.toContain("RULES-TWO");
    const second = await startedAndPrepared(h);
    await drain(h);
    expect(standingOf(lastTask(h, second.machineId))?.text).toContain("RULES-TWO");
  });

  it("a task's later steps never move the stored item back to an older file", async () => {
    const { h, model } = await setup({ file: "version: 1\nrules: RULES-ONE" });
    await startedAndPrepared(h);
    model.commit("main", { [PLAYBOOK_FILE_PATH]: "version: 1\nrules: RULES-TWO" });
    h.clock.advance(60);
    const second = await startedAndPrepared(h);
    await drain(h);
    expect(standingOf(lastTask(h, second.machineId))?.text).toContain("RULES-TWO");
    const revision = (await h.store.get(projectPlaybookKey(COMPANY, "payments")))?.["revision"];
    // The first task is still running under ONE: its steps read the old file and write nothing.
    await drain(h);
    expect((await h.store.get(projectPlaybookKey(COMPANY, "payments")))?.["revision"]).toBe(revision);
  });

  it("refuses to start under a file that cannot be used, with the reason, and writes no task", async () => {
    const { h } = await setup({ file: "version: 1\nstages:\n  check:\n    instructions: x" });
    await expect(h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x", workflow: true })).rejects.toMatchObject({ code: "PROCESS_UNAVAILABLE", message: expect.stringContaining("stages.check") as string });
    expect((await h.flow.list(h.owner)).tasks).toEqual([]);
  });

  it("refuses to start when the rules cannot be read, saying so, and writes no task", async () => {
    const { h, host } = await setup({ file: FILE });
    host.baseBranchHead = () => Promise.reject(agentXError("RUNTIME_UNAVAILABLE", "down"));
    await expect(h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x", workflow: true })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: expect.stringContaining(COULD_NOT_READ_RULES) as string });
    expect((await h.flow.list(h.owner)).tasks).toEqual([]);
  });
});

describe("which operations carry a block", () => {
  const modes = ["UNDERSTAND", "PLAN", "PLAN_CRITIQUE", "IMPLEMENT", "REVIEW", "FEEDBACK_REVIEW", "SETUP_DRAFT", undefined] as const;

  it("every mode that reads rules carries the company's; verification, the setup run, the spec write and a diagnosis carry none", async () => {
    const { h } = await setup({ company: [RULES] });
    const standing = h.deps.standingInstructions!;
    for (const mode of modes) expect((await standing.forOperation({ project: "payments", mode }))?.text, String(mode)).toContain("Never log customer data.");
    for (const mode of ["CHECKS", "SETUP_AGENT", "SPEC_WRITE"] as const) expect(await standing.forOperation({ project: "payments", mode }), mode).toBeUndefined();
    expect(await standing.forOperation({ project: "payments", mode: "PLAN", purpose: "diagnosis" })).toBeUndefined();
  });

  it("a stage that checks work is also told to judge the change against the Required rules; one that does the work is not", async () => {
    const { h } = await setup({ company: [RULES] });
    const standing = h.deps.standingInstructions!;
    for (const mode of ["PLAN_CRITIQUE", "REVIEW", "FEEDBACK_REVIEW"] as const) expect((await standing.forOperation({ project: "payments", mode }))?.text, mode).toContain("You are checking work, not doing it");
    for (const mode of ["UNDERSTAND", "PLAN", "IMPLEMENT"] as const) expect((await standing.forOperation({ project: "payments", mode }))?.text, mode).not.toContain("You are checking work, not doing it");
  });

  it("the project's file reaches the stages that do the work and not the ones that check it", async () => {
    const { h } = await setup({ file: "version: 1\nrules: PROJECT-RULE\nstages:\n  review:\n    instructions: REVIEW-RULE" });
    const standing = h.deps.standingInstructions!;
    expect((await standing.forOperation({ project: "payments", mode: "IMPLEMENT" }))?.text).toContain("PROJECT-RULE");
    const review = (await standing.forOperation({ project: "payments", mode: "REVIEW" }))?.text;
    expect(review).toContain("REVIEW-RULE");
    expect(review).not.toContain("PROJECT-RULE");
    expect((await standing.forOperation({ project: "payments", mode: "CHECKS" }))).toBeUndefined();
  });

  it("refuses a block too long to send with a clear sentence, and never cuts it: the longest legal rules and file together are over the worker's limit", async () => {
    const emoji = "😀";
    const rules = Array.from({ length: 20 }, () => ({ text: emoji.repeat(600), priority: "required" as const }));
    // Angle brackets are escaped in the block (one byte becomes four), so texts of them are the longest the block can get.
    const file = `version: 1\nrules: "${"<".repeat(3_000)}"\nstages:\n  plan:\n    instructions: "${"<".repeat(3_000)}"`;
    const { h } = await setup({ file, company: [{ version: "1", rules }] });
    await expect(h.deps.standingInstructions!.forOperation({ project: "payments", mode: "PLAN" })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining(STANDING_BLOCK_TOO_LONG) as string });
    // The same rules without the stage's own text fit: a step that does not read it is sent the block whole.
    const reviewing = await h.deps.standingInstructions!.forOperation({ project: "payments", mode: "REVIEW" });
    expect(reviewing?.text).toContain(emoji.repeat(600));
    expect(Buffer.byteLength(reviewing!.text, "utf8")).toBeLessThanOrEqual(65_536);
  });
});
