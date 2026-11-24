// L4-HW4 (audit gap 5): `keepEvidence` on the hosted core. A hosted task whose check failed has its evidence kept when the checks are recorded (per-check output, the failing tests with the change that most likely
// broke each (TE-A6), the baseline words (TE-C1)), and Cloud's Proof tab (`GET /v1/dev/tasks/{id}/evidence`) reads it back; another company reads nothing of it, and a task record that names another company's workspace
// can neither write nor read there. The keeper itself is the laptop's (same guard, caps and redaction); what is pinned here is the hosted wiring over the company-bound store.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { FAILURE_CAUSES_ARTIFACT, EVIDENCE_RAW_ARTIFACT, orgProjectCatalogKey, projectRevisionKey, type CheckEntry, type JsonValue, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { operationKey, taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import type { OperationRecord, TaskRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { evidencePackKey, loadEvidencePack } from "../../packages/broker/src/core/proof/evidence-keep.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { createCoreDevRoutes, type CompanyMembership, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { createHostedEvidence, hostedKeepEvidence, hostedEvidenceBlobs } from "../../packages/broker/src/core-host/hosted-evidence.js";
import { artifactObjectKey } from "../../packages/broker/src/services/callbacks.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";
import { DIGEST, SHA } from "../support/evidence-v2-fixtures.js";
import { writeFileSync } from "node:fs";
import { routeKnownFailing } from "../../packages/broker/src/core-host/known-failing-routes.js";
import { deployedDecisionCards, approvalDecisionProofs, deployedSessionMembers } from "../../packages/broker/src/core-host/deployed-decisions.js";
import { createHostedApprovers, approvalProofKeyOf } from "../../packages/broker/src/core-host/hosted-approvers.js";
import { routeDecisionCards } from "../../packages/broker/src/core/decisions/routes.js";
import { developerIdOf } from "../../packages/broker/src/core/sessions/create.js";
import { projectPk, type AdapterRegistry } from "@agentx/contracts";
import { BaselineRowSchema } from "../../packages/contracts/src/index.js";
import { mintTrustedBaselineRun, recordBaselineRow } from "../../packages/broker/src/core/test-env/baseline-cache.js";

const OTHER = "org_corehost00000000000b";
const OWNER_ID = "person-owner-00000000001";
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
const CHECK = (id: string, label: string) => ({ id, label, command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } });
const FAILING = "tests/cart.test.ts::applies discount";
const TAIL = "FAILED tests/cart.test.ts::applies discount - AssertionError: expected 90 got 100";
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const rawFile = (over: { digest?: string; tail?: string } = {}) => JSON.stringify({
  schemaVersion: 1, candidateDigest: over.digest ?? DIGEST,
  checks: [{ checkId: "readiness:0", outputTail: over.tail ?? TAIL, tests: { total: 2, passed: 1, failed: 1, skipped: 0, errored: 0, names: [{ name: FAILING, status: "failed" }, { name: "tests/cart.test.ts::keeps total", status: "passed" }], newTests: [] } }],
  selection: { method: "full", selected: 2, total: 2 },
});
const causesFile = () => JSON.stringify({ schemaVersion: 1, candidateDigest: DIGEST, checks: [{ checkId: "readiness:0", causes: [{ testId: FAILING, cause: { kind: "change", paths: ["src/cart.ts"], pathsCount: 1, commit: SHA, basis: ["named_in_failure"] } }] }] });
const failedEntry: CheckEntry = { id: "readiness:0", label: "pytest -q", source: "project", before: "passed", after: "failed", class: "regression", output: "", durationMs: 700, exitCode: 1 };

async function world(options: { env?: NodeJS.ProcessEnv } = {}) {
  const fake: FakeWorld = createFakeWorld();
  const logs: Array<Record<string, unknown>> = [];
  const refused: string[] = [];
  const hosted = new Map<string, ReturnType<typeof createHostedEvidence>>();
  const app: CoreHostApp = createCoreHostApp({
    modules: fake.modules, context: () => fake.context(), nowMs: () => fake.clock.now,
    runtime: (registry, companyId) => {
      // The wiring under test: exactly what aws/core-engine-root.ts hands each company's flow.
      const evidence = createHostedEvidence({ blobs: registry.require("object-storage"), store: registry.require("storage"), companyId: companyId, env: options.env ?? {}, now: () => fake.clock.now, log: (entry) => logs.push(entry), refused: (reason) => refused.push(reason) });
      hosted.set(companyId, evidence);
      return {
        callbackSigningKey: Buffer.alloc(32, 7), access: { ...createOwnerTaskAccess(), async checkStart() { return { allowed: true }; }, async canAct(principal, task) { return principal.personId === task.developerId; } },
        repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(fake.clock.now), log: () => undefined, services: SERVICES,
        ciReporting: { honest: true as const, ciMode: () => "their_ci_fix" as const }, flowOptions: { understandFirst: true, keepEvidence: (input) => evidence.keepAfterChecks(input) },
      };
    },
  });
  for (const companyId of [FAKE_COMPANY, OTHER]) {
    await fake.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
    await fake.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
  }
  const members = new Map<string, CompanyMembership>();
  const companyOf = vi.fn(async (caller: DeployedCaller) => members.get(`${caller.principal.personId}|${caller.principal.companyId}`));
  const person = (personId: string, companyId: string): DeployedCaller => { members.set(`${personId}|${companyId}`, { companyId, role: "member" }); return { principal: localOwnerPrincipal({ companyId, personId }), client: "cli" }; };
  const routes = createCoreDevRoutes({ app, companyOf, wiring: () => ({ origin: () => "https://api.example", testEnvironment: { env: options.env ?? {}, catalogName: "owner-starter-list" } }) });
  const blobs = (await app.registry()).require("object-storage");

  /** A task of `companyId` started by `owner` whose current candidate failed `readiness:0`, with the worker's raw file (and causes) saved as the callback saves them. */
  const taskOf = async (owner: DeployedCaller, companyId: string, files: { raw?: string | undefined; causes?: string | undefined } = { raw: rawFile(), causes: causesFile() }, plan?: unknown) => {
    const runtime = await app.runtimeFor(companyId);
    const { task } = await runtime.flow.start({ principal: owner.principal, client: "test", origin: "app" }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true });
    const record = (await readTask(runtime.flow.deps, task.taskId))!;
    const workflow = {
      ...record.workflow!, candidate: { digest: DIGEST, repositories: [] },
      checkPolicy: { required: [CHECK("readiness:0", "pytest -q")], optional: [], selectedOptionalIds: [], proposed: [] },
      verification: { candidateDigest: DIGEST, results: [{ checkId: "readiness:0", status: "FAILED" }] },
    };
    await fake.store.put({ item: { ...(await fake.store.get(taskKey(task.taskId)))!, workflow } as never });
    const current = (await readTask(runtime.flow.deps, task.taskId))!;
    const operationId = "op-checks-1";
    await fake.store.put({ item: { ...operationKey(companyId, current.workspaceId, operationId), entityType: "OPERATION", id: operationId, workspaceId: current.workspaceId, kind: "task", workflowMode: "CHECKS", status: "SUCCEEDED", fence: 1, createdAt: "2026-11-18T00:00:00.000Z", companyId, dispatch: { kind: "task", payload: { workflowMode: "CHECKS", ...(plan === undefined ? {} : { testEnvironment: plan as JsonValue }) } } } });
    for (const [name, text] of [[EVIDENCE_RAW_ARTIFACT, files.raw], [FAILURE_CAUSES_ARTIFACT, files.causes]] as const) {
      if (text === undefined) continue;
      const objectKey = artifactObjectKey(current.workspaceId, operationId, name);
      await blobs.put(objectKey, bytes(text), { contentType: "application/json", metadata: {}, retention: "task-document" });
      await fake.store.put({ item: { ...workspaceKey(companyId, current.workspaceId), sk: `ARTIFACT#${operationId}#${name}`, entityType: "ARTIFACT", id: `art-${name}`, workspaceId: current.workspaceId, operationId, name, objectKey, sha256: sha(text) } });
    }
    const operation = (await fake.store.get(operationKey(companyId, current.workspaceId, operationId)))! as unknown as OperationRecord;
    return { taskId: task.taskId, record: current, runtime, operation };
  };
  const keep = async (t: { record: TaskRecord; operation: OperationRecord }, companyId = t.record.companyId) => {
    await app.runtimeFor(companyId);
    return await hosted.get(companyId)!.keepAfterChecks({ task: t.record, operation: t.operation, workflow: t.record.workflow!, candidateDigest: DIGEST, checks: [failedEntry] });
  };
  const read = (caller: DeployedCaller, taskId: string) => routes.route({ method: "GET", path: `/v1/dev/tasks/${taskId}/evidence`, headers: {} }, caller);
  return { fake, blobs, routes, person, taskOf, keep, read, logs, refused, app, hosted };
}
const body = (answer: { body: string } | undefined): Record<string, unknown> => JSON.parse(answer!.body) as Record<string, unknown>;

describe("a hosted task with a failing check keeps its evidence for the Proof tab", () => {

  it("keeps the pack and the failing test's tail, and the Proof route answers the failing test with the change that most likely broke it", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const t = await w.taskOf(owner, FAKE_COMPANY);
    // Before the keeper ran there is only what Rovara recorded itself: no failing-test list.
    expect(Object.keys(body(await w.read(owner, t.taskId)))).not.toContain("failures");
    expect(await w.keep(t)).toMatchObject({ kept: true });
    const answer = body(await w.read(owner, t.taskId));
    expect(answer["failures"]).toEqual([{ check: "pytest -q", test: FAILING, cause: "likely broken by a change (commit aaaaaaa) to src/cart.ts" }]);
    expect((answer["items"] as Array<{ id: string; sha256?: string; verdict: string; kind: string }>)).toEqual([expect.objectContaining({ id: "evidence:0", kind: "test_report", verdict: "fail", sha256: sha(TAIL) })]);
    // The pack and the tail are under the task, in the registry's object store (the one bucket), bound to the exact code.
    const pack = await loadEvidencePack(w.blobs, { ownerKey: t.record.ownerKey, workspaceId: t.record.workspaceId, taskId: t.taskId }, DIGEST);
    expect(pack?.checks[0]).toMatchObject({ checkId: "readiness:0", after: "failed", outputTailRef: { sha256: sha(TAIL) } });
    expect(await w.blobs.stat(`private/${t.record.ownerKey}/${t.record.workspaceId}/evidence/${t.taskId}/${sha(TAIL)}`)).toMatchObject({ bytes: TAIL.length });
  });

  it("the laptop's guard stands: a raw file with a credential in a tail keeps no secret, and one for other code keeps nothing", async () => {
    const w = await world();
    const owner = w.person(OWNER_ID, FAKE_COMPANY);
    const secret = `ghp_${"Ab1Cd2Ef3Gh4".repeat(3)}`;
    const t = await w.taskOf(owner, FAKE_COMPANY, { raw: rawFile({ tail: `token ${secret} leaked` }) });
    expect(await w.keep(t)).toMatchObject({ kept: true });
    const stored = [...(await w.fake.store.query({ pk: `ORG#${FAKE_COMPANY}#EVIDENCE_BLOB` }).catch(() => ({ items: [] }))).items];
    expect(JSON.stringify(stored)).not.toContain(secret);
    const other = await w.taskOf(owner, FAKE_COMPANY, { raw: rawFile({ digest: "e".repeat(64) }) });
    expect(await w.keep(other)).toEqual({ kept: false, reason: "not_bound" });
    expect(body(await w.read(owner, other.taskId))["failures"]).toBeUndefined();
  });
});

describe("one company's evidence is never another's", () => {

  it("a task record that names another company's workspace keeps nothing there and reads nothing from there", async () => {
    const w = await world();
    const ownerA = w.person(OWNER_ID, FAKE_COMPANY), ownerB = w.person("person-ownerb-0000000001", OTHER);
    const a = await w.taskOf(ownerA, FAKE_COMPANY);
    expect(await w.keep(a)).toMatchObject({ kept: true });
    const packKey = evidencePackKey({ ownerKey: a.record.ownerKey, workspaceId: a.record.workspaceId, taskId: a.taskId }, DIGEST);
    const before = await w.blobs.get(packKey, 10_000_000);
    expect(before).toBeDefined();
    // WRITE: company B's keeper handed A's task record (a corrupted or forged row) writes nothing at A's keys.
    const forged = { record: { ...a.record, companyId: OTHER } as TaskRecord, operation: a.operation };
    expect(await w.keep(forged, OTHER)).toEqual({ kept: false, reason: "fault" });
    expect(Buffer.from((await w.blobs.get(packKey, 10_000_000))!).toString("utf8")).toBe(Buffer.from(before!).toString("utf8"));
    expect(w.refused).toContain("workspace_not_company");
    // READ: B's own task whose row points at A's owner and workspace shows no pack (the shared bucket holds A's, but B's store cannot read it).
    const b = await w.taskOf(ownerB, OTHER, { raw: undefined, causes: undefined });
    await w.fake.store.put({ item: { ...(await w.fake.store.get(taskKey(b.taskId)))!, ownerKey: a.record.ownerKey, workspaceId: a.record.workspaceId } });
    // A's pack bytes sit at the key B's forged row names (B's task id under A's workspace), in the one shared bucket: only the company-bound read keeps them out of B's Proof tab.
    await w.blobs.put(evidencePackKey({ ownerKey: a.record.ownerKey, workspaceId: a.record.workspaceId, taskId: b.taskId }, DIGEST), before!, { contentType: "application/json", metadata: {}, retention: "evidence-std" }, { overwrite: true });
    expect(await loadEvidencePack(w.blobs, { ownerKey: a.record.ownerKey, workspaceId: a.record.workspaceId, taskId: b.taskId }, DIGEST)).toBeDefined();
    const answer = body(await w.read(ownerB, b.taskId));
    expect(answer["failures"]).toBeUndefined();
    expect(JSON.stringify(answer)).not.toContain("applies discount");
    // The route's own read goes through the company-bound store: the raw store would have shown it.
    expect(await loadEvidencePack(w.blobs, { ownerKey: a.record.ownerKey, workspaceId: a.record.workspaceId, taskId: a.taskId }, DIGEST)).toBeDefined();
    expect(await loadEvidencePack(hostedEvidenceBlobs({ blobs: w.blobs, store: w.fake.store, companyId: OTHER }), { ownerKey: a.record.ownerKey, workspaceId: a.record.workspaceId, taskId: a.taskId }, DIGEST)).toBeUndefined();
  });

  it("the raw file is read only through this company's own ARTIFACT row: another workspace's raw file is never kept for this task", async () => {
    const w = await world();
    const ownerA = w.person(OWNER_ID, FAKE_COMPANY);
    const a = await w.taskOf(ownerA, FAKE_COMPANY, {});
    // The row names a key of another workspace: the company reader refuses it, so the pack holds no test details and nothing of that file.
    const foreign = artifactObjectKey("ws-foreign", "op-x", EVIDENCE_RAW_ARTIFACT);
    await w.blobs.put(foreign, bytes(rawFile().replace(FAILING, "tests/foreign.test.ts::stolen")), { contentType: "application/json", metadata: {}, retention: "task-document" });
    const text = rawFile();
    await w.fake.store.put({ item: { ...workspaceKey(FAKE_COMPANY, a.record.workspaceId), sk: `ARTIFACT#op-checks-1#${EVIDENCE_RAW_ARTIFACT}`, entityType: "ARTIFACT", id: "art-x", workspaceId: a.record.workspaceId, operationId: "op-checks-1", name: EVIDENCE_RAW_ARTIFACT, objectKey: foreign, sha256: sha(text) } });
    expect(await w.keep(a)).toMatchObject({ kept: true });
    const pack = await loadEvidencePack(w.blobs, { ownerKey: a.record.ownerKey, workspaceId: a.record.workspaceId, taskId: a.taskId }, DIGEST);
    expect(JSON.stringify(pack)).not.toContain("stolen");
    expect(pack?.checks[0]).toMatchObject({ checkId: "readiness:0", after: "failed" });
    expect(pack?.checks[0]?.tests).toBeUndefined();
    expect(w.refused).toContain("workspace_not_company");
  });
});

describe("the baseline words (TE-C1)", () => {
  const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
  const planOf = (shas: string[]) => ({ revision: 1, digest: "d".repeat(64), roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, checks: [{ id: "unit", kind: "test" }], baselineCandidates: shas.map((value) => ({ sha: value })) });
  const baselineSha = "1".padStart(40, "0");
  const claimed = (value: string) => rawFile().replace('"selection"', `"baseline":{"sha":"${value}","commitsBack":2},"selection"`);
  async function baselineWorld(env: NodeJS.ProcessEnv, companyWithRow: string = FAKE_COMPANY) {
    const w = await world({ env });
    await recordBaselineRow({ store: w.fake.store, now: () => NOW }, mintTrustedBaselineRun({ orgId: companyWithRow, project: "payments", row: BaselineRowSchema.parse({
      recordedAt: new Date(NOW - 3_600_000).toISOString(), envRevision: 1, branch: "main", headSha: baselineSha, finishedAt: new Date(NOW - 3 * 3_600_000).toISOString(), writer: "nightly", tests: { total: 5, passed: 4, failed: 1, skipped: 0 }, failed: ["a::x"], flaky: [] }) }));
    return w;
  }

  it("not for a commit the plan did not offer, and not another company's baseline row", async () => {
    const offered = [await baselineWorld({}), "2".padStart(40, "0")] as const;
    const cases: Array<[Awaited<ReturnType<typeof baselineWorld>>, string, string, string]> = [
      [offered[0], FAKE_COMPANY, offered[1], baselineSha], // the claim is for a sha the plan never offered
      [await baselineWorld({}, OTHER), FAKE_COMPANY, baselineSha, baselineSha], // the only row is another company's
    ];
    for (const [w, companyId, offeredSha, claimSha] of cases) {
      w.fake.clock.now = NOW;
      const owner = w.person(OWNER_ID, companyId);
      const t = await w.taskOf(owner, companyId, { raw: claimed(claimSha) }, planOf([offeredSha]));
      expect(await w.keep(t)).toMatchObject({ kept: true });
      expect(await w.hosted.get(companyId)!.baselineOf(t.record, DIGEST)).toBeUndefined();
    }
  });
});


it("KF end to end: callback artifacts produce a hosted card; one website approval reaches the production result reader and exact Undo", async () => {
  const env = {};
  const w = await world({ env });
  const owner = w.person(OWNER_ID, FAKE_COMPANY);
  const t = await w.taskOf(owner, FAKE_COMPANY);
  const runtime = t.runtime, flow = runtime.flow.deps;
  const workflow = { ...t.record.workflow!, stage: "VERIFY" as const, state: "BLOCKED" as const, checkPolicy: { required: [{ ...CHECK("readiness:0", "unit tests"), kind: "test" as const }], optional: [], selectedOptionalIds: [], proposed: [] } };
  await w.fake.store.put({ item: { ...(await w.fake.store.get(taskKey(t.taskId)))!, workflow } as never });
  const baseline = { recordedAt: new Date(w.fake.clock.now).toISOString(), envRevision: 1, branch: "main", headSha: SHA, finishedAt: new Date(w.fake.clock.now).toISOString(), tests: { total: 2, passed: 1, failed: 1, skipped: 0 }, failed: [FAILING], flaky: [] };
  await w.fake.store.put({ item: { pk: projectPk(FAKE_COMPANY, "payments"), sk: "TESTENV#BASELINE#LATEST", baseline } });
  const keep = hostedKeepEvidence({ store: w.fake.store, blobs: w.blobs, companyId: FAKE_COMPANY, env, now: () => w.fake.clock.now, log: () => undefined });
  await keep({ task: t.record, operation: t.operation, workflow, candidateDigest: DIGEST, checks: [{ ...failedEntry, before: "failed", class: "already_failing" }] });
  let role: "owner" | "admin" | "member" = "member";
  let grant: "administrator" | "developer" = "administrator";
  const people = { membershipOf: async () => ({ companyId: FAKE_COMPANY, role }), projectGrantRole: async () => grant };
  const key = approvalProofKeyOf("test-signing-key".repeat(4));
  const identity = { getPrincipal: async () => owner.principal };
  const approvers = createHostedApprovers({ store: w.fake.store, identity, key, now: () => new Date(w.fake.clock.now) });
  const original = await w.app.registry();
  const registry = { require: (point: string) => point === "approvers" ? approvers : point === "identity" ? identity : original.require(point as never) } as AdapterRegistry;
  const cards = deployedDecisionCards({ runtime, registry, people, proofs: approvalDecisionProofs(key, () => w.fake.clock.now), env });
  const caller = { orgId: FAKE_COMPANY, developerId: developerIdOf(owner.principal), principal: owner.principal, webApp: true as const };
  const list = await routeDecisionCards(cards, caller, { method: "GET", pathname: "/v1/app/decisions", searchParams: new URLSearchParams(), body: {} });
  const view = list!.body as { cards: Array<{ id: string; kind: string; subjectId: string }>; digests: Record<string, string> };
  const card = view.cards.find((card) => card.kind === "fix_setup")!;
  expect(card).toBeDefined();
  const path = `/v1/app/decisions/${card.id.replace(":", "/")}`;
  const act = (action: string, webApp = true) => routeDecisionCards(cards, { ...caller, ...(webApp ? { webApp: true as const } : { webApp: undefined }) }, { method: "POST", pathname: `${path}/${action}`, searchParams: new URLSearchParams(), body: { requestId: randomUUID(), shownDigest: view.digests[card.id] } });
  for (const companyRole of ["owner", "admin"] as const) {
    role = companyRole; grant = "developer";
    expect((await cards.sources.list(caller)).some((item) => item.kind === "fix_setup")).toBe(true);
  }
  role = "member"; grant = "developer";
  await expect(act("approve")).rejects.toThrow();
  grant = "administrator";
  await act("evidence-opened");
  await expect(act("approve", false)).rejects.toThrow();
  expect((await act("approve"))!.statusCode).toBe(200);
  // A newer complete nightly has no failures; the active mark is now the only exemption.
  await w.fake.store.put({ item: { pk: projectPk(FAKE_COMPANY, "payments"), sk: "TESTENV#BASELINE#LATEST", baseline: { ...baseline, tests: { total: 2, passed: 2, failed: 0, skipped: 0 }, failed: [] } } });
  const taskRead = () => w.routes.route({ method: "GET", path: `/v1/dev/tasks/${t.taskId}`, headers: {} }, owner);
  expect(body(await taskRead())).toMatchObject({ task: { testing: { result: "partially_verified" } } });
  const members = deployedSessionMembers(FAKE_COMPANY, people);
  const route = (method: string, body?: unknown) => routeKnownFailing({ flow, principal: owner.principal, companyId: FAKE_COMPANY, members, webApp: true, path: "/v1/app/projects/payments/known-failing", request: { method, path: "/v1/app/projects/payments/known-failing", headers: {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env });
  const read = await route("GET"), answer = JSON.parse(read.body) as { marks: Array<Record<string, unknown>> };
  expect(answer.marks).toHaveLength(1);
  const mark = answer.marks[0]!;
  const undo = { action: "undo", requestId: randomUUID(), name: mark["name"], checkId: mark["checkId"], markedBy: mark["markedBy"], markedAt: mark["markedAt"], epoch: mark["epoch"] };
  const undone = await route("POST", undo);
  expect(JSON.parse(undone.body)).toMatchObject({ status: "done", marks: [] });
  await expect(route("POST", undo)).rejects.toThrow();
  expect(body(await taskRead())).toMatchObject({ task: { testing: { result: "code_failed" } } });
  if (process.env["KF_SNAPSHOT_OUT"] !== undefined) writeFileSync(process.env["KF_SNAPSHOT_OUT"], JSON.stringify({ _about: "Generated by Code hosted-keep-evidence.test.ts KF end-to-end, using real hosted producer, card dispatcher, approval subject and read/Undo handlers.", read: JSON.parse(read.body) as unknown, undo, undone: JSON.parse(undone.body) as unknown }, null, 2) + "\n");
});
