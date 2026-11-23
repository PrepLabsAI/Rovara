import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, WORKER_INVOCATION_FEATURES, WorkerInvocationSchema, canonicalPlanJson, createWorkflowSnapshot, projectRevisionKey, type OrgId, type ProjectDefinition, type WorkerInvocation } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createApplicationPlanningContext, type ApplicationPlanningPorts } from "../../packages/broker/src/core/e2e/application-planning.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { processPlanAnswer } from "../../packages/broker/src/core/plan/process.js";
import type { OperationRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { APPLICATION_PLAN_FEATURE as DISPATCH_APPLICATION_PLAN_FEATURE, structuredPlanContextOf, structuredPlanDispatch } from "../../packages/broker/src/core/plan/context.js";
import type { ApplicationTask } from "../../packages/broker/src/core/e2e/application-seams.js";
import { COMPANY, createHarness, newRequestId, definition, type Harness } from "../support/task-flow-harness.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import type { WorkspaceRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { NOW, planFixture, sha, webApiRow } from "../support/e2e-application-plan-fixtures.js";

function fixture() {
  const fx = planFixture({});
  const workflow = createWorkflowSnapshot({ taskId: "11111111-1111-4111-8111-111111111111", ownerId: "a".repeat(64), now: new Date().toISOString() });
  const task: ApplicationTask = { pk: `DEVTASK#${workflow.taskId}`, sk: "META", entityType: "DEVELOPER_TASK",
    taskId: workflow.taskId, companyId: "company-a", project: "payments", startingRevision: 1, workflow,
    preparedBase: [{ repositoryId: "demo", baseCommitSha: fx.snapshot.commitSha }], developerId: "developer-a", provider: "local-owner", developerName: "Owner", client: "test", title: "Orders export", workspaceId: "22222222-2222-4222-8222-222222222222",
    ownerKey: "a".repeat(64), conversationId: "33333333-3333-4333-8333-333333333333", shared: false, createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
    charge: { member: { pk: "company-a#member", sk: "LIMIT" }, organization: { pk: "company-a", sk: "LIMIT" } } };
  const project = { definition: { ...definition, repositories: [{ ...definition.repositories[0]!, url: "https://github.com/example/demo" }], e2e: fx.policy } satisfies ProjectDefinition,
    registeredBy: "owner", setupApproval: { proposalRef: "setup.json", proposalSha256: "", candidateDigest: fx.snapshot.candidate.digest, decision: "approve" as const } };
  const stored = JSON.stringify({ schemaVersion: "project-setup-source-proposal/v1", issuerOwnerKey: "owner", repositoryUrl: project.definition.repositories[0]!.url,
    identityMapping: { registeredRepositoryId: "demo" }, policy: fx.policy, proposal: fx.setup.proposal,
    snapshot: { ...fx.snapshot, sources: fx.snapshot.sources.map(({ bytes, ...source }) => ({ ...source, bytesBase64: Buffer.from(bytes).toString("base64") })) } });
  project.setupApproval.proposalSha256 = sha(stored);
  const ports: ApplicationPlanningPorts = { project: async (input) => input.project === "payments" && input.startingRevision === 1 ? project : undefined,
    readText: async () => stored, readyRuntimes: async () => [{ kind: "web", profileId: webApiRow("web").profileId, supportedSteps: webApiRow("web").capabilities.supportedSteps, supportedAssertions: webApiRow("web").capabilities.supportedAssertions }], accounts: async () => fx.registry };
  return { fx, task, project, ports, stored };
}

describe("core source-backed application planning", () => {
  it("offers the exact prepared source and current registered account", async () => {
    const { ports, task, fx } = fixture();
    const context = await createApplicationPlanningContext(ports)(task);
    expect(context).toMatchObject({ status: "available", source: { origin: "prepared-commit", commitSha: fx.snapshot.commitSha, preparedCommitStatus: "MATCHED" },
      executableKinds: [{ kind: "web" }] });
    if (context?.status !== "available") throw new Error("expected source-backed context");
    expect(context.runtimeAccountRefs).toContainEqual(fx.accountRef);
  });
  it("does not use a mismatched setup digest or capture of another commit", async () => {
    const { ports, task, fx, project } = fixture();
    project.setupApproval.proposalSha256 = "f".repeat(64);
    expect(await createApplicationPlanningContext(ports)(task)).toMatchObject({ status: "unknown" });
    expect(await createApplicationPlanningContext({ ...ports, readText: async () => "changed" })(task)).toMatchObject({ status: "unknown" });
    expect(await createApplicationPlanningContext({ ...ports, readText: async () => "changed", capture: async () => ({ ...fx.snapshot, commitSha: "c".repeat(40) }) })(task)).toMatchObject({ status: "unknown" });
  });
  it("uses approved setup only without a prepared commit and verifies repository identity", async () => {
    const { ports, task, project } = fixture();
    const { preparedBase: _base, ...unprepared } = task; void _base;
    expect(await createApplicationPlanningContext(ports)(unprepared)).toMatchObject({ status: "available", source: { origin: "approved-setup", preparedCommitStatus: "UNKNOWN" } });
    project.definition.repositories[0]!.url = "https://github.com/other/repo";
    expect(await createApplicationPlanningContext(ports)(task)).toMatchObject({ status: "unknown" });
  });
  it("keeps missing account and runtime reads unavailable rather than inventing authority", async () => {
    const { ports, task } = fixture();
    const context = await createApplicationPlanningContext({ ...ports, accounts: async () => { throw new Error("unavailable"); }, readyRuntimes: async () => [] })(task);
    expect(context).toMatchObject({ status: "available", executableKinds: [], runtimeAccountRefs: [] });
  });
  it("passes application context only to a coding plan's structured rules", async () => {
    const { ports, task } = fixture();
    const h = createHarness(); await h.registerProject({ ...definition, e2e: fixture().fx.policy });
    const applicationE2E = { planning: { context: createApplicationPlanningContext(ports), approve: async () => { throw new Error("not approving"); } } };
    const deps = { ...h.deps, applicationE2E };
    expect((await structuredPlanContextOf(deps, task, task.workflow))?.rules.e2ePlanningContext).toMatchObject({ status: "available" });
    expect((await structuredPlanContextOf(deps, task, { ...task.workflow, path: "FULL", reviewPhase: "REQUIREMENTS" }))?.rules.e2ePlanningContext).toBeUndefined();
  });
});

// Regression: a callback's v2 claim cannot authorize a plan unless the stored operation offered it.
it("reads negotiation from the stored server operation and stores the canonical intent", async () => {
  const h = createHarness({ extra: () => ({ planSelfCheck: false }) });
  await h.registerProject();
  const { task, fx } = fixture();
  const { portableOperationRefs: _portable, mockFixtureRefs: _mocks, ...intent } = fx.intent; void _portable; void _mocks;
  const workflow = { ...task.workflow, definitionVersion: "1.0.0" as const };
  const answer = { content: planAnswer(planDocument({ e2e: intent })), artifact: { id: "application-plan", createdAt: new Date().toISOString() } };
  const operation: OperationRecord = { pk: `WORKSPACE#${task.workspaceId}`, sk: "OPERATION#44444444-4444-4444-8444-444444444444", entityType: "OPERATION",
    id: "44444444-4444-4444-8444-444444444444", workspaceId: task.workspaceId, companyId: task.companyId, eventSequence: 0,
    kind: "task", workflowMode: "PLAN", status: "SUCCEEDED", fence: 1, requestId: "55555555-5555-4555-8555-555555555555", payloadHash: "a".repeat(64),
    createdAt: answer.artifact.createdAt, updatedAt: answer.artifact.createdAt, dispatch: { kind: "task", projectRevision: 1, payload: {} } };
  const objects = new Map<string, string>();
  const blobs = { put: async (key: string, bytes: Uint8Array) => { objects.set(key, Buffer.from(bytes).toString("utf8")); } };
  expect(await processPlanAnswer(h.deps, blobs, { task, workflow, operation, answer })).toMatchObject({ kind: "plan_unreadable" });
  expect(objects.size).toBe(0);
  operation.dispatch.payload["workflowE2EPlanVersion"] = 2;
  const result = await processPlanAnswer(h.deps, blobs, { task, workflow, operation, answer });
  expect(result.kind).toBe("planned");
  if (result.kind !== "planned") throw new Error("expected a planned document");
  const text = objects.get(result.artifact.objectKey)!;
  expect(sha(text)).toBe(result.artifact.sha256);
  const stored = JSON.parse(text) as { e2e: Record<string, unknown> };
  expect(stored.e2e).not.toHaveProperty("portableOperationRefs");
  expect(stored.e2e).not.toHaveProperty("mockFixtureRefs");
});

describe("planning source refusal contracts", () => {
  for (const invalid of ["declined", "issuer", "repository", "kind", "candidate"] as const) it(`does not offer untrusted ${invalid} setup source`, async () => {
    const w = fixture();
    const record = JSON.parse(w.stored) as Record<string, unknown> & { snapshot: { sources: Array<{ kind: string }> } };
    if (invalid === "declined") w.project.setupApproval.decision = "decline" as "approve";
    if (invalid === "issuer") record["issuerOwnerKey"] = "someone-else";
    if (invalid === "repository") record["repositoryUrl"] = "https://github.com/another/repo";
    if (invalid === "kind") record.snapshot.sources[0]!.kind = "symlink";
    if (invalid === "candidate") w.project.setupApproval.candidateDigest = "e".repeat(64);
    const text = JSON.stringify(record); w.project.setupApproval.proposalSha256 = sha(text);
    expect(await createApplicationPlanningContext({ ...w.ports, readText: async () => text })(w.task)).toEqual({ status: "unknown", reason: "trusted source for the exact prepared commit is unavailable" });
  });
  it("captures the exact prepared commit when approved setup is unavailable", async () => {
    const w = fixture(); let captures = 0;
    const ports = { ...w.ports, readText: async () => undefined, capture: async (_task: ApplicationTask, _url: string, commit: string) => {
      captures++; expect(commit).toBe(w.fx.snapshot.commitSha); return w.fx.snapshot;
    } };
    expect(await createApplicationPlanningContext(ports)(w.task)).toMatchObject({ status: "available", source: { commitSha: w.fx.snapshot.commitSha } });
    expect(captures).toBe(1);
    expect(await createApplicationPlanningContext({ ...ports, capture: async () => ({ ...w.fx.snapshot, commitSha: "e".repeat(40) }) })(w.task))
      .toEqual({ status: "unknown", reason: "trusted capture did not match the task's prepared repository commit" });
  });
  for (const invalid of ["project", "revision", "policy", "repositories", "url"] as const) it(`reports unusable ${invalid} before building a planning context`, async () => {
    const w = fixture();
    if (invalid === "project") w.project.definition.name = "another-project";
    if (invalid === "revision") w.project.definition.revision = 2;
    if (invalid === "policy") w.project.definition.e2e = {} as typeof w.fx.policy;
    if (invalid === "repositories") w.project.definition.repositories.push({ ...w.project.definition.repositories[0]!, name: "other" });
    if (invalid === "url") w.project.definition.repositories[0]!.url = "https://example.test/repo";
    const expected = invalid === "project" || invalid === "revision" ? "the task's pinned project revision is unavailable" : invalid === "policy" ? "the task's pinned E2E policy could not be validated"
      : invalid === "repositories" ? "source-backed planning currently requires one pinned repository" : "the registered repository has no supported immutable source identity";
    expect(await createApplicationPlanningContext(w.ports)(w.task)).toEqual({ status: "unknown", reason: expected });
  });
  it("leaves planning unchanged for a project without an E2E policy", async () => {
    const w = fixture(); delete (w.project.definition as ProjectDefinition).e2e;
    expect(await createApplicationPlanningContext(w.ports)(w.task)).toBeUndefined();
  });
});

it("leaves previous plan context absent when there is no earlier canonical plan", async () => {
  const w = fixture(); const h = createHarness(); await h.registerProject();
  const result = await structuredPlanContextOf(h.deps, w.task, w.task.workflow);
  expect(result?.previous).toBeUndefined();
});

it("does not trust a setup snapshot from a different registered repository", async () => {
  const w = fixture();
  w.project.definition.repositories[0]!.url = "https://github.com/another/repository";
  const record = JSON.parse(w.stored) as Record<string, unknown>;
  record["repositoryUrl"] = w.project.definition.repositories[0]!.url;
  const text = JSON.stringify(record); w.project.setupApproval.proposalSha256 = sha(text);
  expect(await createApplicationPlanningContext({ ...w.ports, readText: async () => text })(w.task)).toMatchObject({ status: "unknown" });
});

it("keeps the prior canonical plan in the next planning context", async () => {
  const w = fixture(); const h = createHarness(); await h.registerProject();
  const document = planDocument(); const bytes = Buffer.from(JSON.stringify(document));
  const artifact = { id: "earlier-plan", type: "plan" as const, version: 1, format: "structured" as const, sha256: sha(bytes), objectKey: "earlier-plan.json", producer: "planner", createdAt: new Date(NOW).toISOString() };
  h.deps.artifacts = { get: async () => bytes };
  const workflow = { ...w.task.workflow, artifacts: [artifact] };
  expect((await structuredPlanContextOf(h.deps, w.task, workflow))?.previous).toMatchObject({ kind: "plan", version: 1, plan: { title: document.title } });
});

// The core reads a task's project from its COMPANY partition (aws/core-application-e2e.ts reads `projectRevisionKey(companyId, ...)`). The legacy registration route writes `PROJECT#name`, which the core never reads:
// a policy stored only there is invisible to planning (no context, so no browser round), and a policy in the company partition is offered. This is the boundary the native journeys' fixture had to cross.
describe("the partition the core reads a project's e2e policy from", () => {
  const COMPANY = "org_corehost00000000000a" as OrgId;
  async function portsOver(rows: Array<{ company: string; revision: number; withPolicy: boolean }>) {
    const { ports, task, project } = fixture();
    const store = new MemoryDocumentStore();
    for (const row of rows) {
      const definition = { ...project.definition, revision: row.revision, ...(row.withPolicy ? {} : { e2e: undefined }) };
      const key = row.company === "legacy" ? { pk: "PROJECT#payments", sk: `REV#${String(row.revision).padStart(12, "0")}` } : projectRevisionKey(row.company, "payments", row.revision);
      await store.put({ item: { ...key, entityType: "PROJECT", definition: JSON.parse(JSON.stringify(definition)) as never, registeredBy: project.registeredBy, setupApproval: project.setupApproval } });
    }
    const reading = (company: OrgId) => async (input: { project: string; startingRevision: number }) => {
      const row = await store.get(projectRevisionKey(company, input.project, input.startingRevision));
      return row === undefined ? undefined : { definition: row["definition"] as ProjectDefinition, registeredBy: row["registeredBy"] as string, setupApproval: row["setupApproval"] as typeof project.setupApproval };
    };
    return { task, ports: { ...ports, project: reading(COMPANY) } satisfies ApplicationPlanningPorts };
  }
  it("offers a policy stored in the company partition", async () => {
    const { ports, task } = await portsOver([{ company: COMPANY, revision: 1, withPolicy: true }]);
    expect(await createApplicationPlanningContext(ports)(task)).toMatchObject({ status: "available" });
  });
  it("sees no policy that exists only in the legacy partition (the task pins the company's revision, which has none)", async () => {
    const { ports, task } = await portsOver([{ company: COMPANY, revision: 1, withPolicy: false }, { company: "legacy", revision: 2, withPolicy: true }]);
    expect(await createApplicationPlanningContext(ports)(task)).toBeUndefined();
  });
  it("does not find the implicit company's rows either: the pinned revision is read by the task's own company", async () => {
    const { ports, task } = await portsOver([{ company: IMPLICIT_COMPANY_ID, revision: 1, withPolicy: true }]);
    expect(await createApplicationPlanningContext(ports)(task)).toMatchObject({ status: "unknown" });
  });
});

// The core must negotiate the application plan: a planning run that is offered the application planning context is also told, in its payload, that the version 2 intent is allowed (`workflowE2EPlanVersion: 2`),
// and the step needs a worker that parses it. Without the flag the broker (plan/process.ts) and the worker both refuse the v2 plan the planner was asked to write. Only a project whose pinned revision has an
// e2e policy and a ready runtime is offered the context, so every other project's dispatch must stay exactly as it was.
describe("the core's planning runs negotiate the application plan", () => {
  const APPLICATION_PLAN_FEATURE = "task.workflowE2EApplicationPlan";
  const read = (invocation: WorkerInvocation) => (invocation as unknown as { payload: Record<string, unknown> }).payload;
  const drain = async (h: Harness, rounds = 12) => { for (let round = 0; round < rounds; round += 1) { if ((await h.flow.dispatchOnce({ maxMessages: 10 })).received === 0) return; h.clock.advance(70); } };

  /** A workflow task on the core's 1.1.0 path (Understand first), through preparation and Understand, with its first PLAN run dispatched. */
  async function planning(options: { policy: boolean; readyRuntime?: boolean; features?: readonly string[] }) {
    const w = fixture();
    const objects = new Map<string, Uint8Array>();
    const h = createHarness({ understandFirst: true, machines: { startingChecks: 0, features: [...(options.features ?? WORKER_INVOCATION_FEATURES)] } });
    const registered = options.policy ? w.project.definition : { ...w.project.definition, e2e: undefined };
    await h.registerProject(JSON.parse(JSON.stringify(registered)) as ProjectDefinition);
    h.deps.artifacts = { get: async (key) => objects.get(key) };
    h.deps.applicationE2E = { planning: { context: createApplicationPlanningContext({ ...w.ports, project: async (task) => task.project === "payments" ? { ...w.project, definition: registered } : undefined,
      ...(options.readyRuntime === false ? { readyRuntimes: async () => [] } : {}) }), approve: async () => { throw new Error("not approving"); } } } as never;
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Add an orders CSV export", workflow: true });
    await drain(h);
    const workspace = (await h.store.get(workspaceKey(COMPANY, started.task.workspaceId))) as unknown as WorkspaceRecord;
    const machineId = workspace.machine!.machineId;
    const last = () => h.machines.delivered(machineId).at(-1)!;
    let fence = 1;
    const finish = async (invocation: WorkerInvocation, outcome: Record<string, unknown>) => {
      h.machines.finish(machineId, invocation.operationId);
      await h.flow.recordResult({ workspaceId: workspace.id, operationId: invocation.operationId, fence, status: "SUCCEEDED", outcome } as never);
      fence += 1;
      await drain(h);
    };
    await finish(last(), { kind: "prepared", base: [{ repositoryId: "demo", baseCommitSha: w.fx.snapshot.commitSha }] });
    await finish(last(), { kind: "understood", assessment: { kind: "ready", path: "QUICK", restatement: "Add an orders CSV export", assumptions: [] } });
    const operations = async () => (await h.store.query({ pk: workspaceKey(COMPANY, workspace.id).pk, sk: { op: "beginsWith", prefix: "OPERATION#" } })).items as unknown as OperationRecord[];
    return { h, w, last, finish, objects, operations, taskId: started.task.taskId, workspace, machineId, fence: () => fence };
  }
  const v2Intent = (w: ReturnType<typeof fixture>) => { const { portableOperationRefs: _p, mockFixtureRefs: _m, ...intent } = w.fx.intent; void _p; void _m; return intent; };

  it("a project with an e2e policy and a ready runtime: the first PLAN run carries the version, needs the feature, parses, and the broker takes a v2 plan from it", async () => {
    const p = await planning({ policy: true });
    const invocation = p.last();
    expect(read(invocation)).toMatchObject({ workflowMode: "PLAN", planFormat: "structured", workflowE2EPlanVersion: 2 });
    expect(WorkerInvocationSchema.safeParse(invocation).success).toBe(true);
    const operation = (await p.operations()).find((entry) => entry.id === invocation.operationId)!;
    expect(operation.dispatch.requires).toEqual(expect.arrayContaining(["task.workflowMode", "task.structuredPlans", APPLICATION_PLAN_FEATURE]));
    // The broker accepts the v2 intent from the very operation record that was dispatched.
    p.h.deps.planSelfCheck = false;
    const task = (await readTask(p.h.deps, p.taskId))!;
    const objects = new Map<string, string>();
    const claims = [{ id: "1", text: "The export is added in server.mjs and tests/orders.test.ts covers it." }];
    const answer = { content: planAnswer(planDocument({ claims, e2e: v2Intent(p.w) })), artifact: { id: "application-plan", createdAt: new Date().toISOString() } };
    const result = await processPlanAnswer(p.h.deps, { put: async (key: string, bytes: Uint8Array) => { objects.set(key, Buffer.from(bytes).toString("utf8")); } }, { task, workflow: task.workflow!, operation, answer });
    expect(result.kind === "plan_unreadable" ? result.errors : result.kind).toBe("planned");
  });

  it("a worker that cannot parse the application plan is refused the step, never sent a run it would reject", async () => {
    const p = await planning({ policy: true, features: WORKER_INVOCATION_FEATURES.filter((feature) => feature !== APPLICATION_PLAN_FEATURE) });
    const operations = await p.operations();
    expect(operations.filter((entry) => entry.workflowMode === "PLAN").at(-1)).toMatchObject({ kind: "task", status: "FAILED", error: "this worker is too old to run this step; upgrade it" });
  });

  it("a project without an e2e policy: the PLAN run is exactly what it was (structured, no version, no extra feature)", async () => {
    const p = await planning({ policy: false });
    const invocation = p.last();
    expect(Object.keys(read(invocation)).sort()).toEqual(["conversationId", "planFormat", "prompt", "workflowMode"]);
    const operation = (await p.operations()).find((entry) => entry.id === invocation.operationId)!;
    expect(operation.dispatch.requires).toEqual(["task.workflowMode", "task.structuredPlans"]);
    // Nothing offered the version, so the broker still refuses a v2 plan from this run.
    p.h.deps.planSelfCheck = false;
    const task = (await readTask(p.h.deps, p.taskId))!;
    const claims = [{ id: "1", text: "The export is added in server.mjs and tests/orders.test.ts covers it." }];
    const answer = { content: planAnswer(planDocument({ claims, e2e: v2Intent(p.w) })), artifact: { id: "application-plan", createdAt: new Date().toISOString() } };
    expect((await processPlanAnswer(p.h.deps, { put: async () => undefined }, { task, workflow: task.workflow!, operation, answer })).kind).toBe("plan_unreadable");
  });

  it("a policy with no ready runtime offers no executable kind, so no version is sent", async () => {
    const p = await planning({ policy: true, readyRuntime: false });
    expect(read(p.last())).not.toHaveProperty("workflowE2EPlanVersion");
    const operation = (await p.operations()).find((entry) => entry.id === p.last().operationId)!;
    expect(operation.dispatch.requires).not.toContain(APPLICATION_PLAN_FEATURE);
  });

  it("the planner's automatic second run (REPLAN) is offered the same version, and a project without a policy still is not", async () => {
    for (const policy of [true, false]) {
      const p = await planning({ policy });
      await p.finish(p.last(), { kind: "plan_again", prompt: "The plan lacked its checks; write them.", selfCheck: { artifactType: "plan", version: 1, used: 1 } });
      expect(read(p.last())).toMatchObject({ workflowMode: "PLAN", planFormat: "structured" });
      expect("workflowE2EPlanVersion" in read(p.last())).toBe(policy);
    }
  });

  it("the plan check's revision run (a blocking point sends the plan back) is offered the same version", async () => {
    for (const policy of [true, false]) {
      const p = await planning({ policy });
      const text = canonicalPlanJson(planDocument());
      const artifact = { id: "plan-1", type: "plan" as const, version: 1, sha256: createHash("sha256").update(text, "utf8").digest("hex"), producer: "agentx-worker-untrusted" as const, objectKey: `tasks/${p.taskId}/plan-1.json`, createdAt: new Date(p.h.clock.now).toISOString(), format: "structured" as const };
      p.objects.set(artifact.objectKey, new TextEncoder().encode(text));
      await p.finish(p.last(), { kind: "planned", artifact });
      // The plan check runs on its own (PLAN_CRITIQUE); its saved answer holds one blocking point, so the flow sends the plan back to the planner by a row of its own.
      expect((await readTask(p.h.deps, p.taskId))!.workflow).toMatchObject({ stage: "PLAN_CRITIQUE", state: "RUNNING" });
      const critic = p.last();
      expect(read(critic)).toMatchObject({ workflowMode: "PLAN_CRITIQUE" });
      const answer = `I read the plan.\n\n\`\`\`rovara-plan-critique\n${JSON.stringify({ verdict: "revise", points: [{ id: "p1", severity: "blocking", text: "The plan never says where the export is tested." }] })}\n\`\`\`\n`;
      const answerKey = `tasks/${p.taskId}/plan-critique.md`;
      p.objects.set(answerKey, new TextEncoder().encode(answer));
      await p.h.store.put({ item: { pk: workspaceKey(COMPANY, p.workspace.id).pk, sk: `ARTIFACT#${critic.operationId}#1`, entityType: "ARTIFACT", name: "plan-critique.md", objectKey: answerKey, sha256: createHash("sha256").update(answer, "utf8").digest("hex") } });
      await p.finish(critic, { kind: "ended" });
      p.h.clock.advance(70);
      await drain(p.h);
      const revision = p.last();
      expect(revision.operationId).not.toBe(critic.operationId);
      expect(read(revision)).toMatchObject({ workflowMode: "PLAN", planFormat: "structured" });
      expect("workflowE2EPlanVersion" in read(revision)).toBe(policy);
    }
  });
});

// Review tests (lead 4 Opus, 34f76e6d8): the shared dispatch helper keeps every other planning run's shape exactly: a Markdown (non-structured) run needs only the workflow mode, and a FULL-path
// structured run still names its review phase, with or without the application plan.
describe("structuredPlanDispatch keeps every other planning run's shape", () => {
  const rules = (e2ePlanningContext?: unknown) => ({ rules: { ...(e2ePlanningContext === undefined ? {} : { e2ePlanningContext }) } }) as never;
  const offered = { status: "available", executableKinds: ["web"] };
  it("a Markdown planning run (no structured context): only the workflow mode, no payload", () => {
    expect(structuredPlanDispatch(undefined, { path: "FULL", reviewPhase: "DESIGN" })).toEqual({ requires: ["task.workflowMode"] });
    expect(structuredPlanDispatch(undefined, { path: "QUICK", reviewPhase: undefined })).toEqual({ requires: ["task.workflowMode"] });
  });
  it("a FULL-path structured run names its review phase; a QUICK one does not", () => {
    expect(structuredPlanDispatch(rules(), { path: "FULL", reviewPhase: "DESIGN" })).toEqual({ payload: { planFormat: "structured", workflowPhase: "DESIGN" }, requires: ["task.workflowMode", "task.structuredPlans"] });
    expect(structuredPlanDispatch(rules(), { path: "QUICK", reviewPhase: "DESIGN" })).toEqual({ payload: { planFormat: "structured" }, requires: ["task.workflowMode", "task.structuredPlans"] });
  });
  it("a FULL-path run offered the application plan keeps its phase beside the version", () => {
    expect(structuredPlanDispatch(rules(offered), { path: "FULL", reviewPhase: "IMPLEMENTATION_PLAN" })).toEqual({
      payload: { planFormat: "structured", workflowE2EPlanVersion: 2, workflowPhase: "IMPLEMENTATION_PLAN" }, requires: ["task.workflowMode", "task.structuredPlans", DISPATCH_APPLICATION_PLAN_FEATURE] });
    expect(structuredPlanDispatch(rules({ status: "available", executableKinds: [] }), { path: "FULL", reviewPhase: "DESIGN" })).toEqual({ payload: { planFormat: "structured", workflowPhase: "DESIGN" }, requires: ["task.workflowMode", "task.structuredPlans"] });
    expect(structuredPlanDispatch(rules({ status: "unknown", reason: "no policy", executableKinds: ["web"] }), { path: "QUICK", reviewPhase: undefined })).toEqual({ payload: { planFormat: "structured" }, requires: ["task.workflowMode", "task.structuredPlans"] });
  });
});
