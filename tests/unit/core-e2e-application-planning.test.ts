import { describe, expect, it } from "vitest";
import { createWorkflowSnapshot, type ProjectDefinition } from "@agentx/contracts";
import { createApplicationPlanningContext, type ApplicationPlanningPorts } from "../../packages/broker/src/core/e2e/application-planning.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { processPlanAnswer } from "../../packages/broker/src/core/plan/process.js";
import type { OperationRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { structuredPlanContextOf } from "../../packages/broker/src/core/plan/context.js";
import type { ApplicationTask } from "../../packages/broker/src/core/e2e/application-seams.js";
import { createHarness, definition } from "../support/task-flow-harness.js";
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
