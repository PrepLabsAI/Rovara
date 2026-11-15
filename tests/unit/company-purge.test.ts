// Company purge (C112, plan row 13.5): operator only, a closed company only, a cooling-off delay with a cancel window, a dry run in counts, bounded passes that resume after a fault, idempotent,
// and company-scoped: the second company's data (and the people both share) is untouched, byte for byte.
import { describe, expect, it } from "vitest";
import { DocumentStoreError, type OrgId, type StoredDocument } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { DocumentAuditSink } from "../../packages/local-adapters/src/document-audit-sink.js";
import { MemoryQueueService } from "../../packages/broker/src/ports/memory-queue.js";
import { workspaceKey, taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { legacyOperationRequestKey } from "../../packages/broker/src/core/task-flow/legacy-keys.js";
import { TASK_FLOW_INDEXES } from "../../packages/broker/src/core/task-flow/flow.js";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import {
  COMPANY_PURGE_COOLING_OFF_MIN_MS, COMPANY_PURGE_COOLING_OFF_MS, PURGE_COMPANY_OPEN, PURGE_NOT_CANCELLABLE, PURGE_OPERATOR_ONLY, cancelCompanyPurge, companyPurgeKey, companyPurgeState,
  dryRunCompanyPurge, requestCompanyPurge, resumeCompanyPurges, runCompanyPurge, unversionedPurgeObjects, PURGE_CLOSED_UNKNOWN, PURGE_EARLIER_CLOSE, COMPANY_PURGE_BUDGET_MAX_MS, PURGE_DRY_RUN_HANDLE, PURGE_NEW_REQUEST_ID, type CompanyClosure, type CompanyPurgeDeps, type CompanyPurgeOperator,
} from "../../packages/broker/src/core/company/purge.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const OP: CompanyPurgeOperator = { kind: "operator", operatorId: "ops_ana" };
const REQ = "11111111-2222-4333-8444-555555555555";
const REQ2 = "11111111-2222-4333-8444-666666666666";
const DAY = 24 * 3_600_000;

/** A versioned bucket in miniature: each key holds a count of versions; a prefix delete removes every version under the prefix. */
class Versions {
  readonly objects = new Map<string, number>();
  readonly deleted: string[] = [];
  failPrefix: string | undefined;
  outOfTimePrefix: string | undefined;
  put(key: string, versions = 3): void { this.objects.set(key, versions); }
  under(prefix: string): string[] { return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort(); }
  readonly port = {
    deleteEveryVersion: async (prefix: string): Promise<boolean | "out_of_time"> => {
      if (this.failPrefix !== undefined && prefix.startsWith(this.failPrefix)) return false;
      if (this.outOfTimePrefix !== undefined && prefix.startsWith(this.outOfTimePrefix)) { this.outOfTimePrefix = undefined; return "out_of_time"; }
      for (const key of this.under(prefix)) this.objects.delete(key);
      this.deleted.push(prefix);
      return true;
    },
  };
}

interface World { store: MemoryDocumentStore; files: Versions; clock: { now: number }; closed: Map<string, string>; deps: CompanyPurgeDeps; logs: Record<string, unknown>[]; audit: DocumentAuditSink }

function world(overrides: Partial<CompanyPurgeDeps> = {}, store = new MemoryDocumentStore()): World {
  const files = new Versions();
  const clock = { now: Date.parse("2026-11-15T10:00:00.000Z") };
  // Each closed company and the id of its current close.
  const closed = new Map<string, string>([[A, "close-1"], [B, "close-1"]]);
  const logs: Record<string, unknown>[] = [];
  const audit = new DocumentAuditSink({ store: () => store });
  const deps: CompanyPurgeDeps = {
    store, objects: files.port, audit, now: () => clock.now, companyClosure: async (companyId) => (closed.has(companyId) ? { closed: true, closeId: closed.get(companyId)! } : { closed: false }), log: (entry) => logs.push(entry), ...overrides,
  };
  return { store, files, clock, closed, deps, logs, audit };
}

/** Everything in the store, sorted. */
async function all(store: MemoryDocumentStore): Promise<StoredDocument[]> {
  const out: StoredDocument[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.scanPage({ limit: 1_000, ...(cursor === undefined ? {} : { cursor }) });
    out.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return out;
}
const ofCompany = (items: StoredDocument[], tag: string, company: string): StoredDocument[] => items.filter((item) => JSON.stringify(item).includes(tag) || JSON.stringify(item).includes(company));

/** One company's engine data in every shape the purge must reach, plus the rows it must keep. `tag` makes every id unique to the company. */
async function seed(w: World, company: OrgId, tag: string): Promise<void> {
  const put = async (item: StoredDocument): Promise<void> => { await w.store.put({ item }); };
  const task = `task-${tag}-1`;
  const ws = `ws-${tag}-1`;
  const owner = `owner-${tag}`;
  await put({ pk: `ORG#${company}`, sk: "META", entityType: "ORG", name: `Company ${tag}` });
  await put({ pk: `ORG#${company}`, sk: "LEARNING_SETTINGS", mode: "suggest" });
  await put({ pk: `ORG#${company}#SETTINGS`, sk: "MAIN", value: `settings ${tag}` });
  await put({ pk: `ORG#${company}#COST#${task}`, sk: "ENTRY#1", cents: 12 });
  await put({ pk: `ORG#${company}#PROJECT_CATALOG`, sk: `proj-${tag}`, name: `Project ${tag}` });
  await put({ pk: `ORG#${company}#EVIDENCE_BLOB`, sk: `private/${owner}/${ws}/evidence/${task}/aa`, bytes: "x" });
  await put({ pk: `ORG#${company}#AUDIT_COPY`, sk: "HEAD", count: 1, hash: "h" });
  await put({ pk: `WS#${company}#P#proj-${tag}`, sk: "LESSON#1", text: `lesson ${tag}` });
  // The task and its workspace: proved by their META; their other rows carry no company.
  await put({ pk: `DEVTASK#${task}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: task, companyId: company, ownerKey: owner, workspaceId: ws, title: `title ${tag}` });
  await put({ pk: `DEVTASK#${task}`, sk: "NOTE#1", text: `note ${tag}` });
  await put({ pk: `DEVTASK#${task}`, sk: "PLAN_EVIDENCE#1", ref: `plan ${tag}` });
  await put({ pk: `WORKSPACE#${ws}`, sk: "META", entityType: "WORKSPACE", companyId: company, orgId: company, ownerKey: owner });
  await put({ pk: `WORKSPACE#${ws}`, sk: "OPERATION#op1", status: "DONE" });
  await put({ pk: `IDEMPOTENCY#${owner}#${ws}`, sk: "REQUEST#r1", operationId: "op1" });
  // The person both companies share: their sign-in rows stay; their task-list row of this company goes.
  await put({ pk: "DEVELOPER#dev_shared", sk: "META", entityType: "DEVELOPER", name: "Shared Person" });
  await put({ pk: "DEVELOPER#dev_shared", sk: `TASK#2026-11-01#${task}`, taskId: task, orgId: company });
  await put({ pk: "DEVELOPER_LIMIT#dev_shared", sk: `TASK#${task}`, taskId: task });
  // A person whose home company this is: their sign-in row names it, and still stays (it is removed by the member removal or the person erase).
  await put({ pk: `DEVELOPER#dev_${tag}`, sk: "META", entityType: "DEVELOPER", orgId: company });
  // Install-wide lists that name the company in the key.
  await put({ pk: "OPEN_AGENT_SESSIONS", sk: `${company}#ses-${tag}`, at: 1 });
  await put({ pk: "EGRESS_DOMAINS", sk: `ORG#${company}#example.com`, allowed: true });
  await put({ pk: "CORE_ENGINE_IN_USE", sk: `ORG#${company}`, since: 1 });
  // A row outside any company partition that names the task by id.
  await put({ pk: `GITHUB_PR#repo-${tag}`, sk: "PR#1", taskId: task });
  // The audit trail: one ordinary event (tombstoned later).
  await w.audit.record({ eventId: `task.started:${task}`, companyId: company, at: "2026-11-01T00:00:00.000Z", actor: { type: "person", id: "dev_shared" }, action: "task.started", subject: { type: "task", id: task }, details: { project: `proj-${tag}` } });
  // Files: the workspace's (evidence, plans, run artifacts) in several versions, and the company's fixtures.
  w.files.put(`private/${owner}/${ws}/evidence/${task}/sha-${tag}`);
  w.files.put(`private/${owner}/${ws}/evidence-pack/${task}/pack-${tag}.json`);
  w.files.put(`private/${owner}/${ws}/plan-documents/plan-${tag}.json`);
  w.files.put(`private/${owner}/${ws}/op1/out-${tag}.txt`);
  w.files.put(`private/${company}/fixtures/fx-${tag}`);
}

async function purgeToEnd(w: World, company: string, options: { step?: number; budgetMs?: number; calls?: number } = {}): Promise<number> {
  for (let call = 1; call <= (options.calls ?? 200); call += 1) {
    const progress = await runCompanyPurge(w.deps, company, options.budgetMs ?? 60_000);
    if (progress.outcome === "done") return call;
    w.clock.now += options.step ?? 70_000;
  }
  throw new Error("the purge did not finish");
}

async function scheduledAndDue(w: World, company: OrgId = A): Promise<void> {
  await requestCompanyPurge(w.deps, { companyId: company, by: OP, requestId: REQ });
  w.clock.now += COMPANY_PURGE_COOLING_OFF_MS;
}

/** Use the CORE writer so the regression follows the current workspace key format. */
async function startCoreWorkspace(w: World, companyId: OrgId) {
  const h = createHarness({ companyId, backend: () => ({ store: w.store, queues: new MemoryQueueService() }) });
  await h.registerProject();
  const { task } = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Add a health endpoint" });
  const key = workspaceKey(companyId, task.workspaceId);
  const meta = await w.store.get(key);
  expect(meta).toMatchObject({ companyId, orgId: companyId, id: task.workspaceId });
  if (typeof meta?.["ownerKey"] !== "string") throw new Error("workspace owner missing");
  const prefix = `private/${meta["ownerKey"]}/${task.workspaceId}/`;
  for (const path of ["plan-documents/plan.json", "op1/output.txt", "workflow-e2e-artifacts/run.json", `evidence/${task.taskId}/blob`]) w.files.put(`${prefix}${path}`);
  return { key, prefix, taskId: task.taskId, workspaceId: task.workspaceId, ownerKey: meta["ownerKey"] };
}

describe("company purge: CORE company-scoped workspaces", () => {
  it("proves the scoped META before deleting it and removes the rows and every workspace file", async () => {
    const w = world({}, new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES }));
    const started = await startCoreWorkspace(w, A);
    // The offline backfill currently retains this legacy side partition after moving META.
    const legacyRequest = legacyOperationRequestKey(started.ownerKey, started.workspaceId, "old-request");
    await w.store.put({ item: { ...legacyRequest, operationId: "old-operation", payloadHash: "old-payload" } });
    const metaAtFileDeletion: Array<StoredDocument | undefined> = [];
    w.deps.objects = { deleteEveryVersion: async (prefix) => {
      if (prefix === started.prefix) metaAtFileDeletion.push(await w.store.get(started.key));
      return w.files.port.deleteEveryVersion(prefix);
    } };
    await scheduledAndDue(w);
    await purgeToEnd(w, A);
    expect(w.files.under(started.prefix)).toEqual([]);
    expect(metaAtFileDeletion).toHaveLength(1);
    expect(metaAtFileDeletion[0]).toMatchObject({ companyId: A });
    expect((await w.store.query({ pk: started.key.pk })).items).toEqual([]);
    expect(await w.store.get(taskKey(started.taskId))).toBeUndefined();
    expect(await w.store.get(legacyRequest)).toBeUndefined();
  });

  it("purges A's scoped workspace files while leaving B's scoped rows and file versions unchanged", async () => {
    const w = world({}, new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES }));
    const a = await startCoreWorkspace(w, A);
    const b = await startCoreWorkspace(w, B);
    const beforeRows = ofCompany(await all(w.store), b.key.pk, B);
    const beforeFiles = [...w.files.objects].filter(([key]) => key.startsWith(b.prefix));
    expect(beforeFiles).toHaveLength(4);
    await scheduledAndDue(w);
    await purgeToEnd(w, A);
    expect(w.files.under(a.prefix)).toEqual([]);
    expect((await w.store.query({ pk: a.key.pk })).items).toEqual([]);
    expect(ofCompany(await all(w.store), b.key.pk, B)).toEqual(beforeRows);
    expect([...w.files.objects].filter(([key]) => key.startsWith(b.prefix))).toEqual(beforeFiles);
    expect(w.files.deleted).not.toContain(b.prefix);
  });
});

describe("company purge: who may ask, and when", () => {
  it("refuses anyone but an operator, with fixed words and nothing written", async () => {
    const w = world();
    for (const by of [undefined, null, {}, { kind: "member", operatorId: "ops_ana" }, { kind: "operator" }, { kind: "operator", operatorId: "has space" }, { kind: "operator", operatorId: "" }, { personId: "dev_admin", role: "owner" }]) {
      await expect(requestCompanyPurge(w.deps, { companyId: A, by: by as unknown as CompanyPurgeOperator, requestId: REQ })).rejects.toThrow(PURGE_OPERATOR_ONLY);
      await expect(cancelCompanyPurge(w.deps, { companyId: A, by: by as unknown as CompanyPurgeOperator })).rejects.toThrow(PURGE_OPERATOR_ONLY);
      await expect(dryRunCompanyPurge(w.deps, { companyId: A, by: by as unknown as CompanyPurgeOperator })).rejects.toThrow(PURGE_OPERATOR_ONLY);
    }
    expect(await all(w.store)).toEqual([]);
  });

  it("refuses a company that is not closed, and one whose closed check fails or is not wired", async () => {
    const w = world();
    w.closed.delete(A);
    await expect(requestCompanyPurge(w.deps, { companyId: A, by: OP, requestId: REQ })).rejects.toThrow(PURGE_COMPANY_OPEN);
    // A closed state that cannot be read is said so (and nothing is scheduled), not called "open".
    const throwing = world({ companyClosure: async () => { throw new Error("down"); } });
    await expect(requestCompanyPurge(throwing.deps, { companyId: A, by: OP, requestId: REQ })).rejects.toThrow(PURGE_CLOSED_UNKNOWN);
    const truthy = world({ companyClosure: async () => ({ closed: "yes" }) as unknown as CompanyClosure });
    const noClose = world({ companyClosure: async () => ({ closed: true, closeId: "has space" }) });
    await expect(requestCompanyPurge(noClose.deps, { companyId: A, by: OP, requestId: REQ })).rejects.toThrow(PURGE_CLOSED_UNKNOWN);
    await expect(requestCompanyPurge(truthy.deps, { companyId: A, by: OP, requestId: REQ })).rejects.toThrow(PURGE_CLOSED_UNKNOWN);
    for (const other of [throwing, truthy, noClose]) expect(await other.store.get(companyPurgeKey(A))).toBeUndefined();
    const unwired = world({ companyClosure: undefined as unknown as CompanyPurgeDeps["companyClosure"] });
    await expect(requestCompanyPurge(unwired.deps, { companyId: A, by: OP, requestId: REQ })).rejects.toThrow("not wired");
    expect(await w.store.get(companyPurgeKey(A))).toBeUndefined();
  });

  it("refuses a bad company id or request id", async () => {
    const w = world();
    await expect(requestCompanyPurge(w.deps, { companyId: "ORG#x", by: OP, requestId: REQ })).rejects.toThrow("That is not a company id.");
    await expect(requestCompanyPurge(w.deps, { companyId: A, by: OP, requestId: "not-a-uuid" })).rejects.toThrow("The request id is not valid.");
  });

  it("schedules after the cooling-off delay with its audit event; asking again keeps the first request and records nothing", async () => {
    const w = world();
    const first = await requestCompanyPurge(w.deps, { companyId: A, by: OP, requestId: REQ });
    expect(first).toMatchObject({ status: "scheduled", alreadyRequested: false, requestedBy: "ops_ana", dueAt: new Date(w.clock.now + COMPANY_PURGE_COOLING_OFF_MS).toISOString() });
    const events = (await all(w.store)).filter((item) => item.pk === `ORG#${A}#AUDIT`);
    expect(events.map((item) => item["action"])).toEqual(["company.purge_requested"]);
    expect(events[0]!["actor"]).toEqual({ type: "system", id: "operator:ops_ana" });
    w.clock.now += 1_000;
    const again = await requestCompanyPurge(w.deps, { companyId: A, by: OP, requestId: REQ2 });
    expect(again).toMatchObject({ alreadyRequested: true, requestId: REQ, requestedAt: first.requestedAt, dueAt: first.dueAt });
    expect((await all(w.store)).filter((item) => item.pk === `ORG#${A}#AUDIT`)).toHaveLength(1);
  });

  it("keeps the cooling-off delay inside its bounds", async () => {
    const short = world({ coolingOffMs: 1 });
    const state = await requestCompanyPurge(short.deps, { companyId: A, by: OP, requestId: REQ });
    expect(Date.parse(state.dueAt) - short.clock.now).toBe(COMPANY_PURGE_COOLING_OFF_MIN_MS);
    const odd = world({ coolingOffMs: Number.NaN });
    expect(Date.parse((await requestCompanyPurge(odd.deps, { companyId: A, by: OP, requestId: REQ })).dueAt) - odd.clock.now).toBe(COMPANY_PURGE_COOLING_OFF_MS);
  });

  it("does nothing before it is due", async () => {
    const w = world();
    await seed(w, A, "a");
    await requestCompanyPurge(w.deps, { companyId: A, by: OP, requestId: REQ });
    const before = await all(w.store);
    w.clock.now += COMPANY_PURGE_COOLING_OFF_MS - 1;
    expect(await runCompanyPurge(w.deps, A)).toEqual({ companyId: A, outcome: "waiting" });
    expect(await all(w.store)).toEqual(before);
    expect(w.files.deleted).toEqual([]);
  });

  it("cancels inside the window (with its audit event), not after; a cancelled purge never runs and a new request schedules again", async () => {
    const w = world();
    await seed(w, A, "a");
    await requestCompanyPurge(w.deps, { companyId: A, by: OP, requestId: REQ });
    w.clock.now += DAY;
    expect(await cancelCompanyPurge(w.deps, { companyId: A, by: OP })).toMatchObject({ status: "cancelled" });
    expect((await all(w.store)).filter((item) => item.pk === `ORG#${A}#AUDIT`).map((item) => item["action"]).sort()).toEqual(["company.purge_cancelled", "company.purge_requested", "task.started"]);
    w.clock.now += COMPANY_PURGE_COOLING_OFF_MS;
    const before = await all(w.store);
    expect(await runCompanyPurge(w.deps, A)).toEqual({ companyId: A, outcome: "idle" });
    expect(await all(w.store)).toEqual(before);
    const again = await requestCompanyPurge(w.deps, { companyId: A, by: OP, requestId: REQ2 });
    expect(again).toMatchObject({ status: "scheduled", alreadyRequested: false, requestId: REQ2 });
    w.clock.now = Date.parse(again.dueAt);
    await expect(cancelCompanyPurge(w.deps, { companyId: A, by: OP })).rejects.toThrow(PURGE_NOT_CANCELLABLE);
  });

  it("cannot be cancelled once running or done", async () => {
    const w = world();
    await seed(w, A, "a");
    await scheduledAndDue(w);
    await purgeToEnd(w, A);
    await expect(cancelCompanyPurge(w.deps, { companyId: A, by: OP })).rejects.toThrow(PURGE_NOT_CANCELLABLE);
  });

  it("cancels a due purge whose company is open again (with its audit event), and a later close needs a new request and a new cooling-off", async () => {
    const w = world();
    await seed(w, A, "a");
    await scheduledAndDue(w);
    w.closed.delete(A);
    const rowsBefore = (await all(w.store)).filter((item) => item.pk !== "COMPANY_PURGE" && item.pk !== `ORG#${A}#AUDIT`);
    expect(await runCompanyPurge(w.deps, A)).toEqual({ companyId: A, outcome: "cancelled" });
    expect((await all(w.store)).filter((item) => item.pk !== "COMPANY_PURGE" && item.pk !== `ORG#${A}#AUDIT`)).toEqual(rowsBefore);
    expect(w.files.deleted).toEqual([]);
    const cancelled = await w.store.get({ pk: `ORG#${A}#AUDIT`, sk: `EVENT#company-purge:${A}:${REQ}:cancelled` });
    expect(cancelled).toMatchObject({ action: "company.purge_cancelled", details: { reason: "company_open" } });
    // Closed again months later: nothing runs until a new request's cooling-off is over.
    w.closed.set(A, "close-2");
    w.clock.now += 90 * DAY;
    expect(await runCompanyPurge(w.deps, A)).toEqual({ companyId: A, outcome: "idle" });
    expect((await resumeCompanyPurges(w.deps, 60_000))).toEqual([]);
    const again = await requestCompanyPurge(w.deps, { companyId: A, by: OP, requestId: REQ2 });
    expect(again.dueAt).toBe(new Date(w.clock.now + COMPANY_PURGE_COOLING_OFF_MS).toISOString());
    expect((await runCompanyPurge(w.deps, A)).outcome).toBe("waiting");
  });

  it("holds a started purge while the company does not read as closed, touching nothing", async () => {
    const w = world();
    await seed(w, A, "a");
    await scheduledAndDue(w);
    expect((await runCompanyPurge(w.deps, A, 0)).outcome).toBe("working");
    w.closed.delete(A);
    const before = await all(w.store);
    const deletedBefore = [...w.files.deleted];
    expect(await runCompanyPurge(w.deps, A)).toEqual({ companyId: A, outcome: "not_closed" });
    expect(await all(w.store)).toEqual(before);
    expect(w.files.deleted).toEqual(deletedBefore);
    // Closed again under another close: still held, never resumed on its own; the operator may cancel it now.
    w.closed.set(A, "close-2");
    expect(await runCompanyPurge(w.deps, A)).toEqual({ companyId: A, outcome: "not_closed" });
    expect(await all(w.store)).toEqual(before);
    expect(await cancelCompanyPurge(w.deps, { companyId: A, by: OP })).toMatchObject({ status: "cancelled" });
    expect(await runCompanyPurge(w.deps, A)).toEqual({ companyId: A, outcome: "idle" });
  });

  it("refuses to cancel a running purge while its close holds or cannot be read", async () => {
    let unknown = false;
    const w = world();
    const deps: CompanyPurgeDeps = { ...w.deps, companyClosure: async (companyId) => { if (unknown) throw new Error("down"); return await w.deps.companyClosure(companyId); } };
    await seed(w, A, "a");
    await requestCompanyPurge(deps, { companyId: A, by: OP, requestId: REQ });
    w.clock.now += COMPANY_PURGE_COOLING_OFF_MS;
    expect((await runCompanyPurge(deps, A, 0)).outcome).toBe("working");
    await expect(cancelCompanyPurge(deps, { companyId: A, by: OP })).rejects.toThrow(PURGE_NOT_CANCELLABLE);
    unknown = true;
    await expect(cancelCompanyPurge(deps, { companyId: A, by: OP })).rejects.toThrow(PURGE_NOT_CANCELLABLE);
    expect((await companyPurgeState(deps, A))!.status).toBe("running");
  });

  it("waits, never cancels, when the closed check fails at the due time", async () => {
    let flaky = true;
    const w = world();
    const deps: CompanyPurgeDeps = { ...w.deps, companyClosure: async (companyId) => { if (flaky) throw new Error("timeout"); return await w.deps.companyClosure(companyId); } };
    await seed(w, A, "a");
    await scheduledAndDue(w);
    for (const answer of [() => { throw new Error("timeout"); }, () => ({ closed: "maybe" }), () => null, () => ({ closed: true })]) {
      const odd: CompanyPurgeDeps = { ...w.deps, companyClosure: async () => answer() as unknown as CompanyClosure };
      expect(await runCompanyPurge(odd, A)).toEqual({ companyId: A, outcome: "waiting" });
    }
    expect(await runCompanyPurge(deps, A)).toEqual({ companyId: A, outcome: "waiting" });
    expect((await companyPurgeState(w.deps, A))!.status).toBe("scheduled");
    flaky = false;
    await purgeToEnd({ ...w, deps }, A);
  });

  it("tells the operator, rather than 'already requested', when the scheduled purge is tied to an earlier close", async () => {
    const w = world();
    await requestCompanyPurge(w.deps, { companyId: A, by: OP, requestId: REQ });
    expect((await requestCompanyPurge(w.deps, { companyId: A, by: OP, requestId: REQ2 })).alreadyRequested).toBe(true);
    w.closed.set(A, "close-2");
    await expect(requestCompanyPurge(w.deps, { companyId: A, by: OP, requestId: REQ2 })).rejects.toThrow(PURGE_EARLIER_CLOSE);
    w.closed.delete(A);
    await expect(requestCompanyPurge(w.deps, { companyId: A, by: OP, requestId: REQ2 })).rejects.toThrow(PURGE_EARLIER_CLOSE);
    expect((await companyPurgeState(w.deps, A))!.requestId).toBe(REQ);
  });

  it("caps any one call's time at 15 minutes, whatever its caller asks", async () => {
    const w = world();
    await seed(w, A, "a");
    await scheduledAndDue(w);
    const s = w.store;
    let lease: number | undefined;
    const deps: CompanyPurgeDeps = { ...w.deps, store: {
      get: (key) => s.get(key), getMany: (keys) => s.getMany(keys), query: (request) => s.query(request), put: (request) => s.put(request), delete: (request) => s.delete(request),
      transact: async (items) => { for (const item of items) if (item.kind === "update") for (const op of item.ops) if (op.op === "set" && op.path[0] === "leaseUntil") lease = op.value as number; return await s.transact(items); },
      update: (request) => s.update(request), scanPage: (request) => s.scanPage(request),
    } };
    const start = w.clock.now;
    await runCompanyPurge(deps, A, 10 * 24 * 3_600_000);
    expect(lease).toBe(start + COMPANY_PURGE_BUDGET_MAX_MS + 60_000);
  });

  it("cancels a due purge whose company was reopened and closed again inside the window (another close)", async () => {
    const w = world();
    await seed(w, A, "a");
    await requestCompanyPurge(w.deps, { companyId: A, by: OP, requestId: REQ });
    w.closed.delete(A);
    w.clock.now += 2 * DAY;
    w.closed.set(A, "close-2");
    w.clock.now += COMPANY_PURGE_COOLING_OFF_MS;
    expect(await runCompanyPurge(w.deps, A)).toEqual({ companyId: A, outcome: "cancelled" });
    expect(await w.store.get({ pk: `ORG#${A}#AUDIT`, sk: `EVENT#company-purge:${A}:${REQ}:cancelled` })).toMatchObject({ details: { reason: "closed_again" } });
    expect(await w.store.get({ pk: `ORG#${A}#SETTINGS`, sk: "MAIN" })).toBeDefined();
  });

  it("schedules a new purge for a company closed again after an earlier purge was done", async () => {
    const w = world();
    await seed(w, A, "a");
    await scheduledAndDue(w);
    await purgeToEnd(w, A);
    await w.store.put({ item: { pk: `ORG#${A}#SETTINGS`, sk: "MAIN", value: "new" } });
    await expect(requestCompanyPurge(w.deps, { companyId: A, by: OP, requestId: REQ })).rejects.toThrow(PURGE_NEW_REQUEST_ID);
    const again = await requestCompanyPurge(w.deps, { companyId: A, by: OP, requestId: REQ2 });
    expect(again).toMatchObject({ status: "scheduled", alreadyRequested: false, requestId: REQ2 });
    w.clock.now = Date.parse(again.dueAt);
    await purgeToEnd(w, A);
    expect(await w.store.get({ pk: `ORG#${A}#SETTINGS`, sk: "MAIN" })).toBeUndefined();
  });
});

describe("company purge: what goes and what stays", () => {
  it("removes every engine row and every file version of the company, and leaves the other company untouched", async () => {
    const w = world();
    await seed(w, A, "a");
    await seed(w, B, "b");
    const conflicting: StoredDocument = { pk: "MISC#x", sk: "ROW", companyId: A, orgId: B };
    await w.store.put({ item: conflicting });
    // A row in the other company's partition that claims this company: never touched.
    const forged: StoredDocument = { pk: `ORG#${B}#SETTINGS`, sk: "FORGED", companyId: A };
    await w.store.put({ item: forged });
    const beforeB = ofCompany(await all(w.store), "-b", B).filter((item) => !item.pk.startsWith("DEVELOPER#dev_shared") || item.sk !== "META");
    const filesB = w.files.under("private/").filter((key) => key.includes("-b") || key.includes(B));
    await scheduledAndDue(w);
    await purgeToEnd(w, A);

    const after = await all(w.store);
    // The other company: every row exactly as it was, and every file.
    for (const item of beforeB) expect(after).toContainEqual(item);
    expect(w.files.under("private/").filter((key) => key.includes("-b") || key.includes(B))).toEqual(filesB);
    // This company: no file at all.
    expect(w.files.under("private/").filter((key) => key.includes("-a") || key.includes(A))).toEqual([]);
    // This company: only the kept rows.
    const left = after.filter((item) => JSON.stringify(item).includes("-a") || JSON.stringify(item).includes(A));
    const shape = left.map((item) => `${item.pk.replace(A, "A")} | ${item.sk.replace(A, "A")}`).sort();
    expect(shape).toEqual([
      "COMPANY_PURGE | A",
      "DEVELOPER#dev_a | META",
      "DEVELOPER_LIMIT#dev_shared | TASK#task-a-1",
      "MISC#x | ROW",
      "ORG#A | META",
      "ORG#A#AUDIT | EVENT#company-purge:A:" + REQ + ":done",
      "ORG#A#AUDIT | EVENT#company-purge:A:" + REQ + ":requested",
      "ORG#A#AUDIT | EVENT#company-purge:A:" + REQ + ":started",
      "ORG#A#AUDIT | EVENT#task.started:task-a-1",
      "ORG#A#AUDIT_COPY | HEAD",
      `ORG#${B}#SETTINGS | FORGED`,
    ]);
    expect(after).toContainEqual(forged);
    // The shared person's sign-in row stays.
    expect(after).toContainEqual({ pk: "DEVELOPER#dev_shared", sk: "META", entityType: "DEVELOPER", name: "Shared Person" });
    // A row that names two companies is never touched.
    expect(after).toContainEqual(conflicting);
    // The audit event is a tombstone: its place in the chain without its content.
    const tomb = after.find((item) => item.sk === "EVENT#task.started:task-a-1")!;
    expect(tomb).toMatchObject({ tombstone: true, eventId: "task.started:task-a-1", at: "2026-11-01T00:00:00.000Z", companyId: A, entityType: "AUDIT" });
    for (const gone of ["actor", "action", "subject", "details", "digest"]) expect(tomb[gone]).toBeUndefined();
    expect(tomb["contentDigest"]).toBeUndefined();
    // The purge's own record: counts only.
    const done = after.find((item) => item.sk === `EVENT#company-purge:${A}:${REQ}:done`)!;
    expect(done["action"]).toBe("company.purged");
    expect(Object.values(done["details"] as Record<string, unknown>).every((value) => typeof value === "number")).toBe(true);
    const state = await companyPurgeState(w.deps, A);
    expect(state).toMatchObject({ status: "done", counts: { tombstoned: 1, partitions: 2, refused: 0, conflicting: 1 } });
    // 6 company rows, 3 task rows, 2 workspace rows, 1 accepted request, 1 task-list row, 3 install-wide list rows, 1 row naming the task.
    expect(state!.counts.deleted).toBe(17);
  });

  it("a retry of a tombstoned audit event is refused, never restores its content", async () => {
    const w = world();
    await seed(w, A, "a");
    await scheduledAndDue(w);
    await purgeToEnd(w, A);
    await expect(w.audit.record({ eventId: "task.started:task-a-1", companyId: A, at: "2026-11-01T00:00:00.000Z", actor: { type: "person", id: "dev_shared" }, action: "task.started", subject: { type: "task", id: "task-a-1" }, details: { project: "proj-a" } })).rejects.toThrow();
    const tomb = await w.store.get({ pk: `ORG#${A}#AUDIT`, sk: "EVENT#task.started:task-a-1" });
    expect(tomb!["details"]).toBeUndefined();
  });

  it("is idempotent: a run after done changes nothing", async () => {
    const w = world();
    await seed(w, A, "a");
    await scheduledAndDue(w);
    await purgeToEnd(w, A);
    const after = await all(w.store);
    const progress = await runCompanyPurge(w.deps, A);
    expect(progress.outcome).toBe("done");
    expect(await all(w.store)).toEqual(after);
  });

  it("removes a row written late (after the first pass) before it says done", async () => {
    const w = world();
    await seed(w, A, "a");
    await scheduledAndDue(w);
    // One small step at a time so the late row lands mid-purge.
    let late = false;
    for (let call = 0; call < 500; call += 1) {
      const progress = await runCompanyPurge(w.deps, A, 0);
      if (progress.outcome === "done") break;
      if (!late && (await companyPurgeState(w.deps, A))!.counts.deleted > 5) {
        await w.store.put({ item: { pk: `ORG#${A}#LATE`, sk: "ROW", text: "late" } });
        await w.store.put({ item: { pk: "DEVTASK#task-a-late", sk: "META", companyId: A, ownerKey: "owner-a", workspaceId: "ws-a-late" } });
        await w.store.put({ item: { pk: "DEVTASK#task-a-late", sk: "NOTE#1", text: "late" } });
        late = true;
      }
      w.clock.now += 70_000;
    }
    expect(late).toBe(true);
    expect((await companyPurgeState(w.deps, A))!.status).toBe("done");
    const rows = await all(w.store);
    expect(rows.filter((item) => item.pk === `ORG#${A}#LATE` || item.pk === "DEVTASK#task-a-late")).toEqual([]);
  });

  it("never reports done while a file prefix could not be emptied", async () => {
    const w = world();
    await seed(w, A, "a");
    await scheduledAndDue(w);
    w.files.failPrefix = "private/owner-a/ws-a-1/";
    for (let call = 0; call < 20; call += 1) {
      expect((await runCompanyPurge(w.deps, A)).outcome).toBe("working");
      w.clock.now += 70_000;
    }
    // The workspace's rows stay with its files: they are what names the files.
    expect(await w.store.get({ pk: "WORKSPACE#ws-a-1", sk: "META" })).toBeDefined();
    w.files.failPrefix = undefined;
    await purgeToEnd(w, A);
    expect(w.files.under("private/owner-a/")).toEqual([]);
  });

  it("counts a workspace whose ids are not plain as refused and deletes no file for it", async () => {
    const w = world();
    await w.store.put({ item: { pk: "WORKSPACE#ws-odd", sk: "META", companyId: A, ownerKey: "../other" } });
    w.files.put("private/other/x");
    await scheduledAndDue(w);
    await purgeToEnd(w, A);
    expect(w.files.under("private/other/")).toEqual(["private/other/x"]);
    expect((await companyPurgeState(w.deps, A))!.counts.refused).toBe(1);
    expect(await w.store.get({ pk: "WORKSPACE#ws-odd", sk: "META" })).toBeUndefined();
  });

  it("never proves a task or workspace whose META names no company", async () => {
    const w = world();
    const orphan: StoredDocument[] = [
      { pk: "DEVTASK#task-none", sk: "META", ownerKey: "owner-n", workspaceId: "ws-n", taskId: "task-none" },
      { pk: "DEVTASK#task-none", sk: "NOTE#1", text: "n" },
      { pk: "WORKSPACE#ws-n", sk: "META", ownerKey: "owner-n" },
    ];
    for (const item of orphan) await w.store.put({ item });
    w.files.put("private/owner-n/ws-n/evidence/task-none/x");
    await scheduledAndDue(w);
    await purgeToEnd(w, A);
    for (const item of orphan) expect(await w.store.get({ pk: item.pk, sk: item.sk })).toEqual(item);
    expect(w.files.under("private/owner-n/")).toHaveLength(1);
  });

  it("leaves a proved partition's META when it no longer names the company", async () => {
    const w = world();
    await w.store.put({ item: { pk: "DEVTASK#task-x", sk: "META", companyId: A, ownerKey: "owner-x", workspaceId: "ws-x" } });
    w.files.put("private/owner-x/ws-x/evidence/task-x/f");
    await scheduledAndDue(w);
    // Prove it (one tiny step), then change its company before the partition is emptied: no file and no row of it goes, not only its META.
    for (let call = 0; call < 50 && (await w.store.get({ pk: `COMPANY_PURGE_PART#${A}`, sk: "DEVTASK#task-x" })) === undefined; call += 1) {
      await runCompanyPurge(w.deps, A, 0);
      w.clock.now += 70_000;
    }
    await w.store.put({ item: { pk: "DEVTASK#task-x", sk: "META", companyId: B, ownerKey: "owner-x", workspaceId: "ws-x" } });
    // A row of the partition written by its new company, and one elsewhere that names the task: neither goes.
    await w.store.put({ item: { pk: "DEVTASK#task-x", sk: "NOTE#1", text: "x" } });
    await w.store.put({ item: { pk: "GITHUB_PR#repo-x", sk: "PR#1", taskId: "task-x" } });
    await purgeToEnd(w, A);
    expect(await w.store.get({ pk: "GITHUB_PR#repo-x", sk: "PR#1" })).toBeDefined();
    expect(await w.store.get({ pk: "DEVTASK#task-x", sk: "META" })).toMatchObject({ companyId: B });
    expect(await w.store.get({ pk: "DEVTASK#task-x", sk: "NOTE#1" })).toBeDefined();
    expect(w.files.under("private/owner-x/")).toEqual(["private/owner-x/ws-x/evidence/task-x/f"]);
    expect(w.logs.some((entry) => entry["event"] === "company_purge.partition_foreign")).toBe(true);
  });

  it("stops emptying a partition as soon as its META comes to name another company mid-way", async () => {
    const w = world();
    await w.store.put({ item: { pk: "DEVTASK#task-z", sk: "META", companyId: A, ownerKey: "owner-z", workspaceId: "ws-z" } });
    // Rows that sort before META: the walk meets them before the task is proved, so only the partition's emptying reaches them.
    for (let i = 0; i < 350; i += 1) await w.store.put({ item: { pk: "DEVTASK#task-z", sk: `ACT#${String(i).padStart(3, "0")}` } });
    const s = w.store;
    let pages = 0;
    const deps: CompanyPurgeDeps = { ...w.deps, store: {
      get: (key) => s.get(key), getMany: (keys) => s.getMany(keys), put: (request) => s.put(request), update: (request) => s.update(request), delete: (request) => s.delete(request),
      transact: (items) => s.transact(items), scanPage: (request) => s.scanPage(request),
      query: async (request) => {
        const page = await s.query(request);
        if (request.pk === "DEVTASK#task-z" && ++pages === 1) await s.put({ item: { pk: "DEVTASK#task-z", sk: "META", companyId: B, ownerKey: "owner-z", workspaceId: "ws-z" } });
        return page;
      },
    } };
    await requestCompanyPurge(deps, { companyId: A, by: OP, requestId: REQ });
    w.clock.now += COMPANY_PURGE_COOLING_OFF_MS;
    for (let call = 0; call < 50 && (await runCompanyPurge(deps, A)).outcome !== "done"; call += 1) w.clock.now += 1_000;
    expect(pages).toBeGreaterThan(0);
    const left = (await w.store.query({ pk: "DEVTASK#task-z" })).items;
    expect(left.length).toBeGreaterThanOrEqual(101);
    expect(left.find((row) => row.sk === "META")).toMatchObject({ companyId: B });
  });

  it("never deletes a META whose orgId came to name another company just before its delete", async () => {
    const w = world();
    await w.store.put({ item: { pk: "DEVTASK#task-y", sk: "META", companyId: A, orgId: A, ownerKey: "owner-y", workspaceId: "ws-y" } });
    const s = w.store;
    const deps: CompanyPurgeDeps = { ...w.deps, store: {
      get: (key) => s.get(key), getMany: (keys) => s.getMany(keys), query: (request) => s.query(request), put: (request) => s.put(request), update: (request) => s.update(request),
      transact: (items) => s.transact(items), scanPage: (request) => s.scanPage(request),
      delete: async (request) => {
        // Between the partition's last page and its META delete, the META's orgId moves to another company.
        if (request.key.pk === "DEVTASK#task-y" && request.key.sk === "META") await s.update({ key: request.key, ops: [{ op: "set", path: ["orgId"], value: B }] });
        return await s.delete(request);
      },
    } };
    await requestCompanyPurge(deps, { companyId: A, by: OP, requestId: REQ });
    w.clock.now += COMPANY_PURGE_COOLING_OFF_MS;
    for (let call = 0; call < 50 && (await runCompanyPurge(deps, A)).outcome !== "done"; call += 1) w.clock.now += 1_000;
    expect(await w.store.get({ pk: "DEVTASK#task-y", sk: "META" })).toMatchObject({ companyId: A, orgId: B });
  });

  it("clears an earlier purge's recorded partitions on a new request, so nothing it named is acted on without being proved again", async () => {
    const w = world();
    await seed(w, A, "a");
    await scheduledAndDue(w);
    // Run until a partition is recorded, then the company reopens; the held purge is cancelled.
    for (let call = 0; call < 50 && (await w.store.query({ pk: `COMPANY_PURGE_PART#${A}` })).items.length === 0; call += 1) {
      await runCompanyPurge(w.deps, A, 0);
      w.clock.now += 1_000;
    }
    expect((await w.store.query({ pk: `COMPANY_PURGE_PART#${A}` })).items.length).toBeGreaterThan(0);
    w.closed.delete(A);
    await cancelCompanyPurge(w.deps, { companyId: A, by: OP });
    w.closed.set(A, "close-2");
    await requestCompanyPurge(w.deps, { companyId: A, by: OP, requestId: REQ2 });
    for (const pk of [`COMPANY_PURGE_PART#${A}`, `COMPANY_PURGE_MARK#${A}`, `COMPANY_PURGE_DRYRUN#${A}`]) expect((await w.store.query({ pk })).items).toEqual([]);
  });
});

describe("company purge: bounded, resumable, one run at a time", () => {
  it("works in small steps across many calls and ends where one long call ends", async () => {
    const big = world();
    const small = world();
    for (const w of [big, small]) {
      await seed(w, A, "a");
      await seed(w, B, "b");
      for (let i = 0; i < 250; i += 1) await w.store.put({ item: { pk: `ORG#${A}#USAGE#d${String(i)}`, sk: "ROW", n: i } });
      await scheduledAndDue(w);
    }
    const oneCall = await purgeToEnd(big, A);
    const calls = await purgeToEnd(small, A, { budgetMs: 0 });
    expect(calls).toBeGreaterThan(oneCall);
    const strip = (items: StoredDocument[]): unknown[] => items.map((item) => (item.pk === "COMPANY_PURGE" ? { pk: item.pk, sk: item.sk, status: item["status"] } : item.entityType === "AUDIT" ? { pk: item.pk, sk: item.sk } : item));
    expect(strip(await all(small.store))).toEqual(strip(await all(big.store)));
  });

  it("stops each call at its item limit", async () => {
    const w = world();
    for (let i = 0; i < 6_000; i += 1) await w.store.put({ item: { pk: `ORG#${A}#USAGE#d${String(i).padStart(5, "0")}`, sk: "ROW" } });
    await scheduledAndDue(w);
    const progress = await runCompanyPurge(w.deps, A, 3_600_000);
    expect(progress.outcome).toBe("working");
    expect(progress.counts!.deleted).toBeLessThanOrEqual(5_100);
  });

  it("goes on after a store fault from the place it saved, with fixed words", async () => {
    const w = world();
    await seed(w, A, "a");
    await seed(w, B, "b");
    await scheduledAndDue(w);
    expect((await runCompanyPurge(w.deps, A, 0)).outcome).toBe("working");
    w.clock.now += 70_000;
    w.store.injectFault(new DocumentStoreError("unavailable", `the scan failed for ORG#${A}#SETTINGS`), 1);
    // The fault lands on the first store call of the run (the state read): nothing is lost, and its words (which name a key) never come out.
    const first = await runCompanyPurge(w.deps, A).then(() => undefined, (caught: unknown) => caught as Error);
    expect(first?.message).toContain("continues from where it stopped");
    expect(first?.message).not.toContain("SETTINGS");
    w.store.injectFault(new DocumentStoreError("unavailable", `the get failed for ORG#${A}#SETTINGS`), 1);
    const onRequest = await requestCompanyPurge(w.deps, { companyId: B, by: OP, requestId: REQ2 }).then(() => undefined, (caught: unknown) => caught as Error);
    expect(onRequest?.message).not.toContain("SETTINGS");
    w.store.injectFault(new DocumentStoreError("unavailable", `the get failed for ORG#${A}#SETTINGS`), 1);
    const onCancel = await cancelCompanyPurge(w.deps, { companyId: A, by: OP }).then(() => undefined, (caught: unknown) => caught as Error);
    expect(onCancel?.message).not.toContain("SETTINGS");
    const error = await (async () => {
      const s = w.store;
      const failing: CompanyPurgeDeps["store"] = {
        get: (key) => s.get(key), getMany: (keys) => s.getMany(keys), query: (request) => s.query(request), put: (request) => s.put(request), update: (request) => s.update(request),
        delete: (request) => s.delete(request), transact: (items) => s.transact(items), scanPage: async () => { throw new DocumentStoreError("unavailable", `scan of ORG#${A}#SECRET-KEY`); },
      };
      const deps = { ...w.deps, store: failing };
      w.clock.now += 70_000;
      try { await runCompanyPurge(deps, A); return undefined; } catch (caught) { return caught as Error; }
    })();
    expect(error?.message).toContain("continues from where it stopped");
    expect(error?.message).not.toContain(A);
    expect(JSON.stringify(w.logs)).not.toContain("SECRET-KEY");
    w.clock.now += 70_000;
    await purgeToEnd(w, A);
    expect((await all(w.store)).filter((item) => item.pk === `ORG#${A}#SETTINGS`)).toEqual([]);
    expect((await all(w.store)).filter((item) => item.pk === `ORG#${B}#SETTINGS`)).toHaveLength(1);
  });

  it("lets go of the purge when a call ends normally, so the next run need not wait", async () => {
    const w = world();
    await seed(w, A, "a");
    await scheduledAndDue(w);
    expect((await runCompanyPurge(w.deps, A, 0)).outcome).toBe("working");
    w.clock.now += 1_000;
    expect((await runCompanyPurge(w.deps, A, 0)).outcome).toBe("working");
  });

  it("removes a row written into a task or workspace partition after its META was deleted", async () => {
    const w = world();
    await seed(w, A, "a");
    await seed(w, B, "b");
    await scheduledAndDue(w);
    let wrote = false;
    for (let call = 0; call < 500; call += 1) {
      const progress = await runCompanyPurge(w.deps, A, 0);
      if (progress.outcome === "done") break;
      if (!wrote && (await w.store.get({ pk: "DEVTASK#task-a-1", sk: "META" })) === undefined && (await w.store.get({ pk: "WORKSPACE#ws-a-1", sk: "META" })) === undefined) {
        await w.store.put({ item: { pk: "DEVTASK#task-a-1", sk: "STATUS", status: "late" } });
        await w.store.put({ item: { pk: "WORKSPACE#ws-a-1", sk: "OPERATION#late", status: "late" } });
        await w.store.put({ item: { pk: "IDEMPOTENCY#owner-a#ws-a-1", sk: "REQUEST#late" } });
        wrote = true;
      }
      w.clock.now += 1_000;
    }
    expect(wrote).toBe(true);
    expect((await companyPurgeState(w.deps, A))!.status).toBe("done");
    for (const pk of ["DEVTASK#task-a-1", "WORKSPACE#ws-a-1", "IDEMPOTENCY#owner-a#ws-a-1"]) expect((await w.store.query({ pk })).items).toEqual([]);
    for (const pk of ["DEVTASK#task-b-1", "WORKSPACE#ws-b-1", "IDEMPOTENCY#owner-b#ws-b-1"]) expect((await w.store.query({ pk })).items.length).toBeGreaterThan(0);
  });

  it("never ends while a scan page reports rows it could not read", async () => {
    const w = world();
    await seed(w, A, "a");
    let skip = true;
    const s = w.store;
    const deps: CompanyPurgeDeps = { ...w.deps, store: {
      get: (key) => s.get(key), getMany: (keys) => s.getMany(keys), query: (request) => s.query(request), put: (request) => s.put(request), update: (request) => s.update(request),
      delete: (request) => s.delete(request), transact: (items) => s.transact(items), scanPage: async (request) => ({ ...(await s.scanPage(request)), ...(skip ? { skipped: 2 } : {}) }),
    } };
    await requestCompanyPurge(deps, { companyId: A, by: OP, requestId: REQ });
    w.clock.now += COMPANY_PURGE_COOLING_OFF_MS;
    for (let call = 0; call < 30; call += 1) {
      expect((await runCompanyPurge(deps, A)).outcome).toBe("working");
      w.clock.now += 1_000;
    }
    expect((await companyPurgeState(deps, A))!.counts.unreadable).toBe(2);
    expect(w.logs.some((entry) => entry["event"] === "company_purge.unreadable_rows")).toBe(true);
    skip = false;
    for (let call = 0; call < 30 && (await runCompanyPurge(deps, A)).outcome !== "done"; call += 1) w.clock.now += 1_000;
    expect((await companyPurgeState(deps, A))).toMatchObject({ status: "done", counts: { unreadable: 0 } });
  });

  it("follows a partition page that is empty but carries a cursor (rows the store left out), and still moves on", async () => {
    const w = world();
    await w.store.put({ item: { pk: "DEVTASK#task-e", sk: "META", companyId: A, ownerKey: "owner-e", workspaceId: "ws-e" } });
    for (let i = 0; i < 5; i += 1) await w.store.put({ item: { pk: "DEVTASK#task-e", sk: `NOTE#${String(i)}` } });
    const s = w.store;
    let first = true;
    const deps: CompanyPurgeDeps = { ...w.deps, store: {
      get: (key) => s.get(key), getMany: (keys) => s.getMany(keys), put: (request) => s.put(request), update: (request) => s.update(request),
      delete: (request) => s.delete(request), transact: (items) => s.transact(items), scanPage: (request) => s.scanPage(request),
      query: async (request) => {
        if (request.pk === "DEVTASK#task-e" && request.cursor === undefined && first) { first = false; return { items: [], cursor: (await s.query({ pk: request.pk, limit: 1 })).cursor! }; }
        return await s.query(request);
      },
    } };
    await requestCompanyPurge(deps, { companyId: A, by: OP, requestId: REQ });
    w.clock.now += COMPANY_PURGE_COOLING_OFF_MS;
    for (let call = 0; call < 50 && (await runCompanyPurge(deps, A, 0)).outcome !== "done"; call += 1) w.clock.now += 1_000;
    expect((await companyPurgeState(deps, A))!.status).toBe("done");
    expect((await w.store.query({ pk: "DEVTASK#task-e" })).items).toEqual([]);
  });

  it("works from the row as taken, not a copy read before another run moved on", async () => {
    const w = world();
    await seed(w, A, "a");
    await scheduledAndDue(w);
    expect((await runCompanyPurge(w.deps, A, 0)).outcome).toBe("working");
    const s = w.store;
    let interleaved = false;
    const deps: CompanyPurgeDeps = { ...w.deps, store: {
      get: (key) => s.get(key), getMany: (keys) => s.getMany(keys), query: (request) => s.query(request), put: (request) => s.put(request), delete: (request) => s.delete(request),
      transact: (items) => s.transact(items), scanPage: (request) => s.scanPage(request),
      update: async (request) => {
        // Just before this run's take: another run finishes a page that acted, meets an unreadable row, and lets go.
        if (!interleaved && request.key.pk === "COMPANY_PURGE" && request.ops.some((op) => op.path[0] === "runId")) {
          interleaved = true;
          const row = (await s.get(request.key))!;
          const counts = { ...(row["counts"] as Record<string, number>), deleted: (row["counts"] as Record<string, number>)["deleted"]! + 100_000 };
          await s.put({ item: { ...row, acted: true, blocked: true, counts } });
        }
        return await s.update(request);
      },
    } };
    const before = (await companyPurgeState(w.deps, A))!.counts.deleted;
    w.clock.now += 1_000;
    const progress = await runCompanyPurge(deps, A, 0);
    expect(interleaved).toBe(true);
    expect(progress.counts!.deleted).toBeGreaterThanOrEqual(before + 100_000);
    expect((await companyPurgeState(w.deps, A))!.counts.deleted).toBeGreaterThanOrEqual(before + 100_000);
  });

  it("lets only one run hold the purge; a stale hold is taken over", async () => {
    const w = world();
    await seed(w, A, "a");
    await scheduledAndDue(w);
    expect((await runCompanyPurge(w.deps, A, 0)).outcome).toBe("working");
    // Another run holds it (as a run still working does: its budget plus a grace minute): a second run inside the hold waits.
    await w.store.update({ key: companyPurgeKey(A), ops: [{ op: "set", path: ["runId"], value: "other-run" }, { op: "set", path: ["leaseUntil"], value: w.clock.now + 60_000 }] });
    w.clock.now += 1_000;
    const before = await all(w.store);
    expect(await runCompanyPurge(w.deps, A)).toEqual({ companyId: A, outcome: "waiting" });
    expect(await all(w.store)).toEqual(before);
    w.clock.now += 70_000;
    expect((await runCompanyPurge(w.deps, A, 0)).outcome).toBe("working");
  });

  it("resumes every due or running purge, and skips one not yet due", async () => {
    const w = world();
    await seed(w, A, "a");
    await seed(w, B, "b");
    await requestCompanyPurge(w.deps, { companyId: A, by: OP, requestId: REQ });
    w.clock.now += COMPANY_PURGE_COOLING_OFF_MS;
    await requestCompanyPurge(w.deps, { companyId: B, by: OP, requestId: REQ2 });
    let progress = await resumeCompanyPurges(w.deps, 60_000);
    for (let i = 0; i < 50 && !progress.every((each) => each.outcome === "done"); i += 1) { w.clock.now += 70_000; progress = await resumeCompanyPurges(w.deps, 60_000); }
    expect(progress.map((each) => [each.companyId, each.outcome])).toEqual([[A, "done"]]);
    expect((await companyPurgeState(w.deps, B))!.status).toBe("scheduled");
    expect(await w.store.get({ pk: `ORG#${B}#SETTINGS`, sk: "MAIN" })).toBeDefined();
  });
});

describe("company purge: dry run", () => {
  it("answers counts by kind with no write and no id, company-scoped", async () => {
    const w = world();
    await seed(w, A, "a");
    await seed(w, B, "b");
    const before = await all(w.store);
    const filesBefore = [...w.files.objects];
    const report = await dryRunCompanyPurge(w.deps, { companyId: A, by: OP });
    expect(await all(w.store)).toEqual(before);
    expect([...w.files.objects]).toEqual(filesBefore);
    expect(report.complete).toBe(true);
    expect(report.partitions).toEqual({ task: 1, ws: 1 });
    expect(report.tombstones).toBe(1);
    expect(report.rows).toMatchObject({ company: 1, "company:SETTINGS": 1, "company:COST": 1, "team-record": 1, DEVELOPER: 1, OPEN_AGENT_SESSIONS: 1, EGRESS_DOMAINS: 1, CORE_ENGINE_IN_USE: 1 });
    const text = JSON.stringify(report);
    for (const id of [A, B, "task-a-1", "ws-a-1", "owner-a", "proj-a", "-b"]) expect(text).not.toContain(id);
  });

  it("pages with its cursor and never names a key part outside upper-case words", async () => {
    const w = world();
    for (let i = 0; i < 250; i += 1) await w.store.put({ item: { pk: `ORG#${A}#__proto__#${String(i)}`, sk: "ROW" } });
    await seed(w, A, "a");
    let report = await dryRunCompanyPurge(w.deps, { companyId: A, by: OP, budgetMs: 0 });
    let pages = 1;
    let rows = report.rows["company:other"] ?? 0;
    while (!report.complete) {
      report = await dryRunCompanyPurge({ ...w.deps, now: () => (w.clock.now += 1) }, { companyId: A, by: OP, cursor: report.cursor!, budgetMs: 10_000 });
      rows += report.rows["company:other"] ?? 0;
      pages += 1;
    }
    expect(rows).toBe(250);
    expect(pages).toBeGreaterThan(1);
    expect(Object.getPrototypeOf(report.rows)).toBe(Object.prototype);
  });

  it("hands out an opaque handle, never the store's cursor; a handle is used once, expires, and belongs to its company", async () => {
    const w = world();
    for (let i = 0; i < 250; i += 1) await w.store.put({ item: { pk: `DEVTASK#secret-task-${String(i).padStart(3, "0")}`, sk: "META", companyId: B } });
    const partial = await dryRunCompanyPurge(w.deps, { companyId: A, by: OP, budgetMs: 0 });
    expect(partial.complete).toBe(false);
    expect(partial.cursor).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
    expect(Buffer.from(partial.cursor!, "base64url").toString("latin1")).not.toContain("secret-task");
    expect(JSON.stringify(partial)).not.toContain("secret-task");
    // The handle row expires in the store too, when the store has an expiry attribute.
    const ttlStore = world();
    const deps = { ...ttlStore.deps, store: Object.assign(Object.create(null) as object, {
      get: (key: Parameters<MemoryDocumentStore["get"]>[0]) => ttlStore.store.get(key), put: (request: Parameters<MemoryDocumentStore["put"]>[0]) => ttlStore.store.put(request),
      delete: (request: Parameters<MemoryDocumentStore["delete"]>[0]) => ttlStore.store.delete(request), scanPage: (request: Parameters<MemoryDocumentStore["scanPage"]>[0]) => ttlStore.store.scanPage(request), ttlAttribute: "expiresAt",
    }) as unknown as CompanyPurgeDeps["store"] };
    for (let i = 0; i < 150; i += 1) await ttlStore.store.put({ item: { pk: `X#${String(i)}`, sk: "R" } });
    const withTtl = await dryRunCompanyPurge(deps, { companyId: A, by: OP, budgetMs: 0 });
    expect((await ttlStore.store.get({ pk: `COMPANY_PURGE_DRYRUN#${A}`, sk: withTtl.cursor! }))!["expiresAt"]).toBe(Math.ceil((ttlStore.clock.now + 3_600_000) / 1_000));
    // Two calls with the same handle at once: only one gets it.
    const twin = await dryRunCompanyPurge(w.deps, { companyId: A, by: OP, budgetMs: 0 });
    const both = await Promise.allSettled([dryRunCompanyPurge(w.deps, { companyId: A, by: OP, cursor: twin.cursor!, budgetMs: 0 }), dryRunCompanyPurge(w.deps, { companyId: A, by: OP, cursor: twin.cursor!, budgetMs: 0 })]);
    expect(both.filter((each) => each.status === "fulfilled")).toHaveLength(1);
    // Another company cannot use it; a used one cannot be used again; an expired one is refused.
    await expect(dryRunCompanyPurge(w.deps, { companyId: B, by: OP, cursor: partial.cursor! })).rejects.toThrow(PURGE_DRY_RUN_HANDLE);
    const next = await dryRunCompanyPurge(w.deps, { companyId: A, by: OP, cursor: partial.cursor!, budgetMs: 0 });
    await expect(dryRunCompanyPurge(w.deps, { companyId: A, by: OP, cursor: partial.cursor! })).rejects.toThrow(PURGE_DRY_RUN_HANDLE);
    w.clock.now += 3_600_001;
    await expect(dryRunCompanyPurge(w.deps, { companyId: A, by: OP, cursor: next.cursor! })).rejects.toThrow(PURGE_DRY_RUN_HANDLE);
    await expect(dryRunCompanyPurge(w.deps, { companyId: A, by: OP, cursor: "eyJwIjoic2NhbiJ9" })).rejects.toThrow(PURGE_DRY_RUN_HANDLE);
  });
});

describe("company purge: laptop files", () => {
  it("unversionedPurgeObjects passes the prefix delete through", async () => {
    const seen: string[] = [];
    const port = unversionedPurgeObjects({ deletePrefix: async (prefix) => { seen.push(prefix); return true; } });
    expect(await port.deleteEveryVersion("private/o/w/", {})).toBe(true);
    expect(seen).toEqual(["private/o/w/"]);
  });
});
