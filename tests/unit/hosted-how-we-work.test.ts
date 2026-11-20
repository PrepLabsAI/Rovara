// L4-HW3 (owner option A): the project's How we work and the company's rules reach hosted steps. The BROKER (code host, company-instructions point) copies both onto the task's workspace when the task
// starts; the DISPATCHER (no code host, no rules store) builds each step's block from that copy, team rules after them, in the laptop's order. Nothing is read live by the dispatcher, so an edit after
// the start does not change a running task, and another company's rules never appear.
import { describe, expect, it } from "vitest";
import {
  PLAYBOOK_FILE_PATH, WORKER_INVOCATION_FEATURES, projectPlaybookKey, WorkerInvocationSchema, queryAll,
  type CompanyInstructionsSnapshot, type OrgId, type WorkerInvocation,
} from "@agentx/contracts";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import type { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { STANDING_BLOCK_TOO_LONG } from "../../packages/broker/src/core/instructions/step-block.js";
import { PINNED_STANDING_UNREADABLE, type PinnedStanding } from "../../packages/broker/src/core/instructions/pinned.js";
import { hostedStandingInstructions } from "../../packages/broker/src/core-host/standing-instructions.js";
import { hostedDispatcherFlow } from "../../packages/broker/src/aws/worker-machines/dispatcher-core.js";
import { addTeamRule } from "../../packages/broker/src/lessons/team-rules.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import type { OperationRecord, WorkspaceRecord } from "../../packages/broker/src/core/task-flow/records.js";
import type { StandingInstructionsSeam } from "../../packages/broker/src/core/task-flow/deps.js";
import { COMPANY, createHarness, definition, newRequestId, type Harness } from "../support/task-flow-harness.js";
import { fakeCompanyInstructionsSource } from "../support/company-instructions-fake.js";

const URL_ = "https://examplehost.test/acme/app";
const OTHER = "org_other00000000000001" as OrgId;
const RULES: CompanyInstructionsSnapshot = { version: "3", rules: [{ text: "Never log customer data.", priority: "required" }, { text: "Use integer cents.", priority: "preferred" }] };
const OTHER_RULES: CompanyInstructionsSnapshot = { version: "9", rules: [{ text: "OTHER-COMPANY-SECRET-RULE", priority: "required" }] };
const FILE = "version: 1\nrules: PROJECT-RULE ticket id.\nstages:\n  plan:\n    instructions: PLAN-RULE\n  build:\n    instructions: BUILD-RULE\n";
const now = () => 1_800_000_000_000;

/** The registry a hosted broker's runtime has for one company: its storage, its audit sink, ITS code host and (optionally) its company-instructions point. */
function brokerRegistry(h: Harness, host: FakeCodeHost, rules: Parameters<typeof fakeCompanyInstructionsSource>[0] | undefined) {
  const registry = createAdapterRegistry();
  registry.register("storage", "memory", h.store);
  registry.register("audit-sink", "test", h.deps.audit);
  registry.register("code-host", "fake", host);
  const company = rules === undefined ? undefined : fakeCompanyInstructionsSource(rules);
  if (company !== undefined) registry.register("company-instructions", "fake", company);
  return { registry, company };
}

async function setup(options: { file?: string; company?: Parameters<typeof fakeCompanyInstructionsSource>[0] | undefined; teamRule?: string } = {}) {
  const h = createHarness({ understandFirst: true, machines: { features: [...WORKER_INVOCATION_FEATURES] } });
  const project = { ...definition, repositories: [{ ...definition.repositories[0]!, url: URL_, host: { kind: "fake" } }] } as typeof definition;
  await h.registerProject(project);
  const model = new FakeHostModel({ url: URL_, id: "1", fullName: "acme/app", initialFiles: options.file === undefined ? { "README.md": "x" } : { "README.md": "x", [PLAYBOOK_FILE_PATH]: options.file } });
  const host = new FakeCodeHost(model);
  const { registry, company } = brokerRegistry(h, host, options.company);
  // The broker's seam starts the task; the dispatcher's seam (no code host, no company store: the real hostedDispatcherFlow) builds every step's block.
  const broker = hostedStandingInstructions({ registry, companyId: COMPANY, now: () => new Date(h.clock.now) });
  const dispatcher = hostedDispatcherFlow({ ROVARA_CORE_LESSONS: `on:${COMPANY}` }, { companyId: COMPANY, documentClient: { send: async () => ({}) } as never, tableName: "state", store: h.store, people: {} as never, now })!.standingInstructions!;
  if (options.teamRule !== undefined) await addTeamRule(h.store, COMPANY, "payments", { lessonId: "les_team0001", paragraph: options.teamRule, stages: ["PLAN", "IMPLEMENT"] }, now);
  h.deps.standingInstructions = broker;
  return { h, model, host, company, broker, dispatcher };
}

async function operationsOf(h: Harness, workspaceId: string): Promise<OperationRecord[]> {
  const items = await queryAll(h.store, { pk: workspaceKey(COMPANY, workspaceId).pk, sk: { op: "beginsWith", prefix: "OPERATION#" } });
  return items.map((item) => item as unknown as OperationRecord).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.fence - b.fence);
}
async function drain(h: Harness, rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    const report = await h.flow.dispatchOnce({ maxMessages: 10 });
    if (report.received === 0) return;
    h.clock.advance(70);
  }
}
/** Starts a task under the BROKER's seam, then hands the dispatch to the DISPATCHER's seam, and prepares the workspace. */
async function startedAndPrepared(h: Harness, dispatcher: StandingInstructionsSeam) {
  const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Add a /health endpoint", workflow: true });
  h.deps.standingInstructions = dispatcher;
  await drain(h);
  const workspace = (await h.store.get(workspaceKey(COMPANY, started.task.workspaceId))) as unknown as WorkspaceRecord;
  const machineId = workspace.machine!.machineId;
  const prepare = h.machines.delivered(machineId).at(-1)!;
  h.machines.finish(machineId, prepare.operationId);
  await h.flow.recordResult({ workspaceId: workspace.id, operationId: prepare.operationId, fence: 1, status: "SUCCEEDED", outcome: { kind: "prepared" } });
  return { started, workspace, machineId };
}
const lastTask = (h: Harness, machineId: string): WorkerInvocation | undefined => h.machines.delivered(machineId).filter((entry) => entry.kind === "task").at(-1);
const standingOf = (invocation: WorkerInvocation | undefined): { text: string; company?: { version: string; text: string } } | undefined =>
  (invocation as { payload?: { standingInstructions?: { text: string; company?: { version: string; text: string } } } } | undefined)?.payload?.standingInstructions;

describe("a hosted step's block: company rules, then How we work, then team rules", () => {
  it("order: company rules, How we work (the file's rules, then the stage's), then team rules; the company part alone rides along for a second reviewer", async () => {
    const { h, dispatcher } = await setup({ file: FILE, company: [RULES], teamRule: "Ask about currency early." });
    const { workspace, machineId } = await startedAndPrepared(h, dispatcher);
    expect((workspace.standingPin as { playbook?: { file: { rules?: string } } } | undefined)?.playbook?.file.rules).toContain("PROJECT-RULE");
    expect((workspace.standingPin as { company?: { version: string } } | undefined)?.company?.version).toBe("3");
    await drain(h);
    const understand = lastTask(h, machineId)!;
    expect(WorkerInvocationSchema.safeParse(understand).success).toBe(true);
    const block = standingOf(understand)!;
    const at = (needle: string) => block.text.indexOf(needle);
    expect(at("Company rules")).toBeGreaterThan(-1);
    expect(at("- Never log customer data.")).toBeGreaterThan(at("Company rules"));
    expect(at("How we work")).toBeGreaterThan(at("- Use integer cents."));
    expect(at("> PROJECT-RULE ticket id.")).toBeGreaterThan(at("How we work"));
    expect(block.company?.version).toBe("3");
    expect(block.company?.text).not.toContain("PROJECT-RULE");
    // The plan step: the plan stage's own rule comes after the project-wide one, then the team rule for the stage, last.
    const understanding = workspace.id;
    expect(understanding).toBeDefined();
    const planBlock = await dispatcher.forOperation({ project: "payments", mode: "PLAN", pinned: workspace.standingPin });
    const plan = planBlock!.text;
    expect(plan.indexOf("Company rules")).toBeLessThan(plan.indexOf("PROJECT-RULE"));
    expect(plan.indexOf("PROJECT-RULE")).toBeLessThan(plan.indexOf("PLAN-RULE"));
    expect(plan.indexOf("PLAN-RULE")).toBeLessThan(plan.indexOf("Ask about currency early."));
    // The build step does not get the plan stage's rule.
    expect((await dispatcher.forOperation({ project: "payments", mode: "IMPLEMENT", pinned: workspace.standingPin }))!.text).not.toContain("PLAN-RULE");
    // Verification takes no block, as everywhere.
    expect(await dispatcher.forOperation({ project: "payments", mode: "CHECKS", pinned: workspace.standingPin })).toBeUndefined();
  });

  it("the dispatcher's flow reads nothing live: no company-instructions call, no code host, no write", async () => {
    const { h, dispatcher, company, host } = await setup({ file: FILE, company: [RULES] });
    const { workspace } = await startedAndPrepared(h, dispatcher);
    const askedAtStart = [...company!.asked];
    expect(askedAtStart).toEqual([COMPANY]);
    let hostCalls = 0;
    for (const name of ["baseBranchHead", "fileAtRevision", "repositoryIdentity"] as const) {
      const original = (host[name] as (...args: never[]) => unknown).bind(host);
      (host as unknown as Record<string, unknown>)[name] = (...args: never[]) => { hostCalls += 1; return original(...args); };
    }
    await drain(h);
    for (const mode of ["UNDERSTAND", "PLAN", "IMPLEMENT", "REVIEW"] as const) expect((await dispatcher.forOperation({ project: "payments", mode, pinned: workspace.standingPin }))?.text, mode).toContain("Never log customer data.");
    expect(company!.asked).toEqual(askedAtStart);
    expect(hostCalls).toBe(0);
  });

  it("lessons off, or not covering the company: the dispatcher still has the seam (How we work and company rules need no lessons), and leaves out the team rules only", async () => {
    const { h, broker } = await setup({ file: FILE, company: [RULES], teamRule: "Ask about currency early." });
    h.deps.standingInstructions = broker;
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x", workflow: true });
    const pin = ((await h.store.get(workspaceKey(COMPANY, started.task.workspaceId))) as unknown as WorkspaceRecord).standingPin;
    const options = { companyId: COMPANY, documentClient: { send: async () => ({}) } as never, tableName: "state", store: h.store, people: {} as never, now };
    for (const env of [{ ROVARA_CORE_LESSONS: "off" }, { ROVARA_CORE_LESSONS: `on:${OTHER}` }, {}]) {
      const flow = hostedDispatcherFlow(env, options)!;
      expect(flow.standingInstructions, JSON.stringify(env)).not.toBeNull();
      const text = (await flow.standingInstructions!.forOperation({ project: "payments", mode: "PLAN", pinned: pin }))!.text;
      expect(text).toContain("Never log customer data.");
      expect(text).toContain("PROJECT-RULE");
      expect(text).not.toContain("Ask about currency early.");
    }
    // Without the company's runtime options there is still nothing to declare.
    expect(hostedDispatcherFlow({}, undefined)!.standingInstructions).toBeNull();
  });
});

describe("a task keeps the rules it started under (the pin)", () => {

  it("refuses to start, with the reason, when the file cannot be used, the host does not answer, or the company's rules cannot be read or are over the limits; no task is written", async () => {
    const invalid = await setup({ file: "version: 1\nstages:\n  check:\n    instructions: x" });
    await expect(invalid.h.flow.start(invalid.h.owner, { requestId: newRequestId(), project: "payments", instructions: "x", workflow: true })).rejects.toMatchObject({ code: "PROCESS_UNAVAILABLE" });
    const down = await setup({ company: new Error("store down") });
    await expect(down.h.flow.start(down.h.owner, { requestId: newRequestId(), project: "payments", instructions: "x", workflow: true })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: expect.stringContaining("company rules could not be read") as string });
    const tooMany = await setup({ company: [{ version: "1", rules: Array.from({ length: 31 }, (_, i) => ({ text: `rule ${String(i)}`, priority: "required" as const })) }] });
    await expect(tooMany.h.flow.start(tooMany.h.owner, { requestId: newRequestId(), project: "payments", instructions: "x", workflow: true })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    for (const world of [invalid, down, tooMany]) expect((await world.h.flow.list(world.h.owner)).tasks).toEqual([]);
  });
});

describe("a hosted start writes nothing of the repository's file into the company's stored How we work", () => {
  it("a file that carries a design review setting (or none) leaves the stored item and its audit as they were", async () => {
    const file = `${FILE}designReview:\n  mode: never\n  tier: light\n  allowSkip: true\n  capUsdPerTask: 1\n  highRiskApprover:\n    kind: maintainers\n`;
    const { h, dispatcher, broker } = await setup({ file, company: [RULES] });
    const before = JSON.stringify(await h.store.get(projectPlaybookKey(COMPANY, "payments")) ?? null);
    const auditBefore = h.audit.length;
    h.deps.standingInstructions = broker;
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x", workflow: true });
    expect(JSON.stringify(await h.store.get(projectPlaybookKey(COMPANY, "payments")) ?? null)).toBe(before);
    expect(h.audit.length).toBe(auditBefore);
    // The step still carries the file's How we work (the pin has its text).
    const pin = ((await h.store.get(workspaceKey(COMPANY, started.task.workspaceId))) as unknown as WorkspaceRecord).standingPin;
    expect((await dispatcher.forOperation({ project: "payments", mode: "PLAN", pinned: pin }))!.text).toContain("PROJECT-RULE");
  });

  it("a file that parses but fails the recipe's own guards refuses the start with the reason, and a stored pin like it ends the step with the fixed sentence (never a raw error)", async () => {
    const emoji = "😀";
    const { h, dispatcher } = await setup({ file: `version: 1\nrules: "${emoji.repeat(3_900)}"`, company: [RULES] });
    await expect(h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x", workflow: true })).rejects.toMatchObject({ code: "PROCESS_UNAVAILABLE" });
    expect((await h.flow.list(h.owner)).tasks).toEqual([]);
    await expect(dispatcher.forOperation({ project: "payments", mode: "PLAN", pinned: { playbook: { commit: "a".repeat(40), file: { version: 1, rules: emoji.repeat(3_900) } } } })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("company isolation", () => {
  it("the company's rules point is asked for this company only; another company's rules, file and team rules never appear in this company's pin or block", async () => {
    // Company A's broker seam over A's store, with a rules source that has rules for BOTH companies and answers by the id it is asked for.
    const a = createHarness({ understandFirst: true, machines: { features: [...WORKER_INVOCATION_FEATURES] } });
    const project = { ...definition, repositories: [{ ...definition.repositories[0]!, url: URL_, host: { kind: "fake" } }] } as typeof definition;
    await a.registerProject(project);
    const host = new FakeCodeHost(new FakeHostModel({ url: URL_, id: "1", fullName: "acme/app", initialFiles: { "README.md": "x", [PLAYBOOK_FILE_PATH]: FILE } }));
    const asked: string[] = [];
    const bySource = { current: async (company: string) => { asked.push(company); return structuredClone(company === COMPANY ? RULES : OTHER_RULES); } };
    const registry = createAdapterRegistry();
    registry.register("storage", "memory", a.store);
    registry.register("audit-sink", "test", a.deps.audit);
    registry.register("code-host", "fake", host);
    registry.register("company-instructions", "fake", bySource);
    a.deps.standingInstructions = hostedStandingInstructions({ registry, companyId: COMPANY, now: () => new Date(a.clock.now) });
    const started = await a.flow.start(a.owner, { requestId: newRequestId(), project: "payments", instructions: "x", workflow: true });
    expect(asked).toEqual([COMPANY]);
    const pin = ((await a.store.get(workspaceKey(COMPANY, started.task.workspaceId))) as unknown as WorkspaceRecord).standingPin;
    expect(JSON.stringify(pin)).not.toContain("OTHER-COMPANY-SECRET-RULE");
    // Another company's dispatcher, over its own store with its own team rule, never reads company A's pin or A's team rules.
    const store = a.store as MemoryDocumentStore;
    await addTeamRule(store, COMPANY, "payments", { lessonId: "les_aaaa0001", paragraph: "A-ONLY-TEAM-RULE" }, now);
    const forOther = hostedDispatcherFlow({ ROVARA_CORE_LESSONS: "on" }, { companyId: OTHER, documentClient: { send: async () => ({}) } as never, tableName: "state", store, people: {} as never, now })!;
    expect(await forOther.standingInstructions!.forOperation({ project: "payments", mode: "PLAN" })).toBeUndefined();
    const forA = hostedDispatcherFlow({ ROVARA_CORE_LESSONS: "on" }, { companyId: COMPANY, documentClient: { send: async () => ({}) } as never, tableName: "state", store, people: {} as never, now })!;
    const aText = (await forA.standingInstructions!.forOperation({ project: "payments", mode: "PLAN", pinned: pin }))!.text;
    expect(aText).toContain("Never log customer data.");
    expect(aText).toContain("A-ONLY-TEAM-RULE");
    expect(aText).not.toContain("OTHER-COMPANY-SECRET-RULE");
  });

  it("a runtime with no company-instructions point has no company rules and asks nobody; a runtime with no code host reads no file (as a laptop with none)", async () => {
    const h = createHarness({ understandFirst: true });
    await h.registerProject();
    const registry = createAdapterRegistry();
    registry.register("storage", "memory", h.store);
    registry.register("audit-sink", "test", h.deps.audit);
    const seam = hostedStandingInstructions({ registry, companyId: COMPANY, now: () => new Date(h.clock.now) });
    expect(await seam.pin("payments")).toBeUndefined();
    expect(await seam.pinContent!("payments", undefined)).toBeUndefined();
  });
});

describe("untrusted text", () => {

  it("a pinned copy tampered with in the store is refused in fixed words and never put in a prompt (shape, size limits, hidden text)", async () => {
    const { h, dispatcher } = await setup({ file: FILE, company: [RULES] });
    const { workspace } = await startedAndPrepared(h, dispatcher);
    const good = workspace.standingPin as unknown as PinnedStanding;
    const refuse = async (pinned: unknown) => expect(dispatcher.forOperation({ project: "payments", mode: "PLAN", pinned })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining(PINNED_STANDING_UNREADABLE) as string });
    await refuse({ ...good, extra: "x" });
    await refuse({ company: "not a snapshot" });
    await refuse({ playbook: { commit: "not-a-sha", file: good.playbook!.file } });
    await refuse({ playbook: { commit: good.playbook!.commit, file: { version: 1, rules: "x".repeat(4_001) } } });
    await refuse({ playbook: { commit: good.playbook!.commit, file: { version: 2 } } });
    await expect(dispatcher.forOperation({ project: "payments", mode: "PLAN", pinned: { company: { version: "1", rules: Array.from({ length: 31 }, () => ({ text: "r", priority: "required" })) } } })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(dispatcher.forOperation({ project: "payments", mode: "PLAN", pinned: { company: { version: "1", rules: [{ text: "y".repeat(601), priority: "required" }] } } })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    // Hidden characters in a stored file are removed again at the dispatcher.
    const hidden = (await dispatcher.forOperation({ project: "payments", mode: "PLAN", pinned: { playbook: { commit: good.playbook!.commit, file: { version: 1, rules: "A‮B​C" } } } }))!;
    expect(hidden.text).toContain("> ABC");
  });

  it("a block over the worker's limit is refused with the fixed sentence at the dispatch (nothing cut), and the step ends with it", async () => {
    const emoji = "😀";
    const { h, dispatcher } = await setup({ file: `version: 1\nrules: "${"<".repeat(3_000)}"\nstages:\n  plan:\n    instructions: "${"<".repeat(3_000)}"`, company: [{ version: "1", rules: Array.from({ length: 20 }, () => ({ text: emoji.repeat(600), priority: "required" as const })) }] });
    const { workspace } = await startedAndPrepared(h, dispatcher);
    await expect(dispatcher.forOperation({ project: "payments", mode: "PLAN", pinned: workspace.standingPin })).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining(STANDING_BLOCK_TOO_LONG) as string });
    await drain(h);
    const last = (await operationsOf(h, workspace.id)).at(-1)!;
    expect(last).toMatchObject({ kind: "task", status: "FAILED" });
    expect(last.error).toContain(STANDING_BLOCK_TOO_LONG);
  });
});
