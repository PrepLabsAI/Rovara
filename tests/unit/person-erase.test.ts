// Person erase (row 13.1): the engine erase is company-scoped, records its receipt and audit event together, removes the person's chat links and learning data, and erases EVERY version of the
// evidence of the person's tasks in the company (DEC 212), bounded and resumable.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, orgChannelLinkKey, orgDeveloperChannelLinkKey, orgScoped, when, type AuditEvent, type AuditSink, type OrgId, type StoredDocument } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { S3ObjectStorage } from "../../packages/aws-adapters/src/s3/index.js";
import { evidencePrefixesOf } from "../../packages/broker/src/core/proof/evidence-erase.js";
import { taskIndexKey, taskKey, taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import {
  PERSON_ERASE_RETRY_MAX, erasePerson, noLearningToErase, personErasePendingPartition, personErasedKey, resumePersonErases, unversionedEraseObjects, type PersonEraseDeps,
} from "../../packages/broker/src/core/people/erase.js";
import { VersionedBucket } from "../support/versioned-bucket.js";
import { prefsKey } from "../../packages/broker/src/core/notify/prefs.js";
import { notifySentKey } from "../../packages/broker/src/core/notify/attention.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const MALLORY = "dev_mallory";
const ADMIN = "dev_admin";
const OTHER = "dev_other";
const REQ = "11111111-2222-4333-8444-555555555555";

/** An audit sink that stages its record as a put in the caller's transaction (as Cloud's ledger outbox does), once per event id. */
function recordingAudit(): AuditSink & { staged: AuditEvent[] } {
  const staged: AuditEvent[] = [];
  return {
    staged,
    stage: (event) => { staged.push(event); return [{ kind: "put", item: { pk: `AUDIT#${event.companyId}`, sk: event.eventId, entityType: "AUDIT", action: event.action, actor: event.actor.id, subject: event.subject?.id ?? "" }, condition: when.absent() }]; },
    record: async () => undefined,
  };
}

interface World { store: MemoryDocumentStore; bucket: VersionedBucket; audit: ReturnType<typeof recordingAudit>; clock: { now: number }; deps: PersonEraseDeps; learning: string[]; logs: Record<string, unknown>[] }

function world(overrides: Partial<PersonEraseDeps> = {}): World {
  const store = new MemoryDocumentStore();
  const bucket = new VersionedBucket();
  const audit = recordingAudit();
  const clock = { now: Date.parse("2026-11-15T10:00:00.000Z") };
  const learning: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const objects = new S3ObjectStorage({ client: bucket.client, bucket: "artifacts-a", now: () => clock.now });
  const deps: PersonEraseDeps = {
    store, audit, now: () => clock.now, log: (entry) => logs.push(entry),
    objects: { deleteEveryVersion: (prefix, options) => objects.deleteEveryVersion(prefix, options) },
    eraseLearning: async (companyId, personId) => { learning.push(`${companyId}/${personId}`); },
    ...overrides,
  };
  return { store, bucket, audit, clock, deps, learning, logs };
}

let seq = 0;
/** A task of `person` in `company`, with evidence in several versions under both prefixes. */
async function task(w: World, person: string, company: string, options: { record?: Partial<StoredDocument> | null; taskId?: string } = {}): Promise<{ taskId: string; prefixes: string[] }> {
  seq += 1;
  const taskId = options.taskId ?? `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  const createdAt = new Date(Date.parse("2026-11-01T00:00:00.000Z") + seq * 1000).toISOString();
  const ownerKey = taskOwnerKey(person, taskId);
  const workspaceId = `ws${String(seq)}`;
  await w.store.put({ item: { ...taskIndexKey(person, createdAt, taskId), entityType: "DEVELOPER_TASK_INDEX", taskId, orgId: company } });
  if (options.record !== null) await w.store.put({ item: { ...taskKey(taskId), entityType: "DEVELOPER_TASK", taskId, companyId: company, developerId: person, ownerKey, workspaceId, ...(options.record ?? {}) } });
  const prefixes = evidencePrefixesOf({ ownerKey, workspaceId, taskId }) ?? [];
  for (const prefix of prefixes) { w.bucket.write(`${prefix}file1`, 3); w.bucket.write(`${prefix}file2`, 1, true); }
  return { taskId, prefixes };
}
const left = (w: World, prefixes: readonly string[]): number => prefixes.reduce((sum, prefix) => sum + w.bucket.versionsUnder(prefix), 0);

async function link(w: World, company: OrgId, person: string, userId: string): Promise<void> {
  const actor = { channel: "teams", tenant: "tenant1", userId };
  const row = { actor, developerId: person, linkedAt: "2026-11-01T00:00:00.000Z" };
  await w.store.put({ item: { ...orgChannelLinkKey(company, actor), entityType: "CHANNEL_LINK", ...row } });
  await w.store.put({ item: { ...orgDeveloperChannelLinkKey(company, person, actor), entityType: "DEVELOPER_CHANNEL_LINK", ...row } });
}

const erase = (w: World, extra: Partial<Parameters<typeof erasePerson>[1]> = {}) => erasePerson(w.deps, { companyId: A, personId: MALLORY, by: ADMIN, requestId: REQ, ...extra });

describe("person erase: what it removes", () => {
  it("erases every version of both evidence prefixes of the person's tasks in this company", async () => {
    const w = world();
    const one = await task(w, MALLORY, A);
    const two = await task(w, MALLORY, A);
    const receipt = await erase(w);
    expect(left(w, [...one.prefixes, ...two.prefixes])).toBe(0);
    expect(receipt).toMatchObject({ personId: MALLORY, alreadyErased: false, evidence: "done", counts: { tasks: 2, erased: 2, skipped: 0, refused: 0, incomplete: 0 } });
    expect(await w.store.get({ pk: personErasePendingPartition(A), sk: MALLORY })).toBeUndefined();
  });

  it("never touches another company's task, another person's task, or a task whose record names no company", async () => {
    const w = world();
    const theirs = await task(w, MALLORY, B);
    const others = await task(w, OTHER, A);
    const noCompany = await task(w, MALLORY, A, { record: { companyId: null } });
    const receipt = await erase(w);
    expect(left(w, theirs.prefixes)).toBe(10);
    expect(left(w, others.prefixes)).toBe(10);
    expect(left(w, noCompany.prefixes)).toBe(10);
    // The other company's row is passed over uncounted and its record is never fetched; the record that names no valid company is skipped.
    expect(receipt.counts).toMatchObject({ tasks: 1, erased: 0, skipped: 1 });
    expect(receipt.evidence).toBe("done");
  });

  it("never fetches another company's task record, nor counts its row in the receipt", async () => {
    const w = world();
    await task(w, MALLORY, B);
    await task(w, MALLORY, B);
    const fetched: string[] = [];
    const getMany = w.store.getMany.bind(w.store);
    w.store.getMany = async (keys) => { fetched.push(...keys.map((key) => key.pk)); return await getMany(keys); };
    const receipt = await erase(w);
    expect(receipt.counts).toMatchObject({ tasks: 0, skipped: 0, erased: 0 });
    expect(fetched).toEqual([]);
  });

  it("in the implicit company, a legacy task whose record and index row name no company is erased (the repo's company rule)", async () => {
    const w = world();
    const legacy = await task(w, MALLORY, IMPLICIT_COMPANY_ID);
    // Rewrite both rows the way the legacy path wrote them: no company named at all.
    const strip = (row: StoredDocument): StoredDocument => Object.fromEntries(Object.entries(row).filter(([field]) => field !== "companyId" && field !== "orgId")) as StoredDocument;
    await w.store.put({ item: strip((await w.store.get(taskKey(legacy.taskId)))!) });
    const index = (await w.store.query({ pk: `DEVELOPER#${MALLORY}` })).items;
    for (const row of index) await w.store.put({ item: strip(row) });
    const receipt = await erasePerson(w.deps, { companyId: IMPLICIT_COMPANY_ID, personId: MALLORY, by: ADMIN, requestId: REQ });
    expect(receipt).toMatchObject({ evidence: "done", counts: { erased: 1 } });
    expect(left(w, legacy.prefixes)).toBe(0);
  });

  it("removes the person's notification settings and last-sent row in this company only", async () => {
    const w = world();
    for (const company of [A, B]) {
      await w.store.put({ item: { ...prefsKey(company, MALLORY), entityType: "NOTIFY_PREFS", orgId: company, developerId: MALLORY } });
      await w.store.put({ item: { ...notifySentKey(company, MALLORY), entityType: "NOTIFY_SENT", orgId: company, developerId: MALLORY } });
    }
    await erase(w);
    expect(await w.store.get(prefsKey(A, MALLORY))).toBeUndefined();
    expect(await w.store.get(notifySentKey(A, MALLORY))).toBeUndefined();
    expect(await w.store.get(prefsKey(B, MALLORY))).toBeDefined();
    expect(await w.store.get(notifySentKey(B, MALLORY))).toBeDefined();
  });

  it("removes the person's chat links in this company, but not an actor row a re-link gave someone else, nor their links in another company", async () => {
    const w = world();
    await link(w, A, MALLORY, "U1");
    await link(w, A, MALLORY, "U2");
    await link(w, B, MALLORY, "U3");
    // U2 was re-linked to OTHER since: the actor row names OTHER now.
    await w.store.put({ item: { ...orgChannelLinkKey(A, { channel: "teams", tenant: "tenant1", userId: "U2" }), entityType: "CHANNEL_LINK", actor: { channel: "teams", tenant: "tenant1", userId: "U2" }, developerId: OTHER, linkedAt: "2026-11-02T00:00:00.000Z" } });
    const receipt = await erase(w);
    expect(receipt.counts.links).toBe(2);
    expect(await w.store.get(orgChannelLinkKey(A, { channel: "teams", tenant: "tenant1", userId: "U1" }))).toBeUndefined();
    expect(await w.store.get(orgChannelLinkKey(A, { channel: "teams", tenant: "tenant1", userId: "U2" }))).toMatchObject({ developerId: OTHER });
    expect(await w.store.get(orgDeveloperChannelLinkKey(A, MALLORY, { channel: "teams", tenant: "tenant1", userId: "U1" }))).toBeUndefined();
    expect(await w.store.get(orgChannelLinkKey(B, { channel: "teams", tenant: "tenant1", userId: "U3" }))).toMatchObject({ developerId: MALLORY });
  });

  it("asks the learning erase for this company and person", async () => {
    const w = world();
    await erase(w);
    expect(w.learning).toEqual([`${A}/${MALLORY}`]);
  });

  it("works on a laptop's unversioned store too (the folder store's prefix delete)", async () => {
    const w = world();
    const removed: string[] = [];
    w.deps.objects = unversionedEraseObjects({ deletePrefix: async (prefix) => { removed.push(prefix); return true; } });
    const one = await task(w, MALLORY, A);
    expect((await erase(w)).evidence).toBe("done");
    expect(removed).toEqual(one.prefixes);
  });
});

describe("person erase: the receipt and the audit record", () => {
  it("writes the receipt and stages person.erased in the same transaction, naming the admin as actor and the request id", async () => {
    const w = world();
    await erase(w);
    expect(await w.store.get(personErasedKey(A, MALLORY))).toMatchObject({ companyId: A, personId: MALLORY, by: ADMIN, requestId: REQ, erasedAt: "2026-11-15T10:00:00.000Z" });
    expect(w.audit.staged).toHaveLength(1);
    expect(w.audit.staged[0]).toMatchObject({ companyId: A, action: "person.erased", actor: { type: "person", id: ADMIN }, subject: { type: "person", id: MALLORY }, details: { requestId: REQ } });
    expect(await w.store.get({ pk: `AUDIT#${A}`, sk: `person-erase:${A}:${MALLORY}` })).toMatchObject({ action: "person.erased" });
  });

  it("a repeat keeps the first time, records nothing new, and does the clean-up again", async () => {
    const w = world();
    await erase(w);
    w.clock.now += 60_000;
    const late = await task(w, MALLORY, A);
    const again = await erase(w, { requestId: "99999999-2222-4333-8444-555555555555" });
    expect(again).toMatchObject({ alreadyErased: true, erasedAt: "2026-11-15T10:00:00.000Z", evidence: "done" });
    expect(left(w, late.prefixes)).toBe(0);
    expect(await w.store.get(personErasedKey(A, MALLORY))).toMatchObject({ requestId: REQ });
  });

  it("records nothing and erases nothing when the receipt's transaction fails for another reason (the audit record could not be staged)", async () => {
    const w = world();
    await w.store.put({ item: { pk: `AUDIT#${A}`, sk: `person-erase:${A}:${MALLORY}`, entityType: "AUDIT" } });
    const one = await task(w, MALLORY, A);
    await expect(erase(w)).rejects.toThrow(/could not be recorded/u);
    expect(await w.store.get(personErasedKey(A, MALLORY))).toBeUndefined();
    expect(left(w, one.prefixes)).toBe(10);
    expect(w.learning).toEqual([]);
  });

  it("the receipt and pending keys are under the company", () => {
    expect(personErasedKey(A, MALLORY).pk).toBe(orgScoped(A, `PERSON_ERASED#${MALLORY}`));
    expect(personErasePendingPartition(A)).toBe(orgScoped(A, "PERSON_ERASE_PENDING"));
    expect(() => personErasedKey(A, "a#b")).toThrow();
  });
});

describe("person erase: refusals and failures (fixed words)", () => {
  it("refuses a person id, an admin id or a request id that is not plain, before writing anything", async () => {
    const w = world();
    await expect(erase(w, { personId: "x#y" })).rejects.toThrow(/not a person's id/u);
    await expect(erase(w, { by: "a|b" })).rejects.toThrow(/not a person's id/u);
    await expect(erase(w, { requestId: "nope" })).rejects.toThrow(/request id/u);
    await expect(erase(w, { companyId: "acme" })).rejects.toThrow();
    expect(w.audit.staged).toHaveLength(0);
  });

  it("fails loudly when the learning erase is not wired (never reads as nothing to erase)", async () => {
    const w = world({ eraseLearning: undefined as never });
    await expect(erase(w)).rejects.toThrow(/learning erase hook is not wired/u);
    expect(w.audit.staged).toHaveLength(0);
  });

  it("a learning erase that fails says so in fixed words, never its cause; the receipt stays and the walk stays owed", async () => {
    const w = world({ eraseLearning: async () => { throw new Error(`secret ${MALLORY} correction text`); } });
    const failure = await erase(w).then(() => new Error("no failure"), (error: unknown) => error as Error);
    expect(failure.message).toMatch(/suggested-rule data could not be cleared/u);
    expect(failure.message).not.toContain(MALLORY);
    expect(JSON.stringify(w.logs)).not.toContain(MALLORY);
    expect(await w.store.get(personErasedKey(A, MALLORY))).toBeDefined();
    expect(await w.store.get({ pk: personErasePendingPartition(A), sk: MALLORY })).toBeDefined();
  });

  it("noLearningToErase is a no-op hook", async () => {
    expect(await noLearningToErase()).toBeUndefined();
  });
});

describe("person erase: bounded and resumable", () => {
  it("a walk out of time is owed, keeps its cursor, and the resume finishes it", async () => {
    const w = world();
    const tasks = [await task(w, MALLORY, A), await task(w, MALLORY, A), await task(w, MALLORY, A)];
    let calls = 0;
    const real = w.deps.objects;
    w.deps.objects = { deleteEveryVersion: async (prefix, options) => { calls += 1; const outcome = await real.deleteEveryVersion(prefix, options); if (calls === 2) w.clock.now += 10_000; return outcome; } };
    const receipt = await erase(w, { budgetMs: 5_000 });
    expect(receipt.evidence).toBe("owed");
    const pending = await w.store.get({ pk: personErasePendingPartition(A), sk: MALLORY });
    expect(pending?.["cursor"]).toEqual(expect.stringContaining(tasks[0]!.taskId));
    expect(left(w, tasks[0]!.prefixes)).toBe(0);
    expect(left(w, tasks[2]!.prefixes)).toBe(10);
    w.deps.objects = real;
    expect(await resumePersonErases(w.deps, A, 5_000)).toEqual({ finished: 1, owed: 0 });
    expect(left(w, tasks.flatMap((entry) => entry.prefixes))).toBe(0);
    expect(await w.store.get({ pk: personErasePendingPartition(A), sk: MALLORY })).toBeUndefined();
  });

  it("a task that fails is kept for retry and never holds the cursor: later tasks are erased, and the walk is not done until the retry succeeds", async () => {
    const w = world();
    const bad = await task(w, MALLORY, A);
    const good = await task(w, MALLORY, A);
    for (const prefix of bad.prefixes) w.bucket.failKeys.add(`${prefix}file1`);
    const receipt = await erase(w);
    expect(receipt.evidence).toBe("owed");
    expect(receipt.counts.incomplete).toBeGreaterThan(0);
    expect(left(w, good.prefixes)).toBe(0);
    const pending = await w.store.get({ pk: personErasePendingPartition(A), sk: MALLORY });
    expect(pending?.["retry"]).toEqual([expect.stringContaining(bad.taskId)]);
    expect(pending?.["scanned"]).toBe(true);
    w.bucket.failKeys.clear();
    expect(await resumePersonErases(w.deps, A, 5_000)).toEqual({ finished: 1, owed: 0 });
    expect(left(w, bad.prefixes)).toBe(0);
  });

  it("a record the store could not read is kept for retry, never counted as missing", async () => {
    const w = world();
    await task(w, MALLORY, A);
    const getMany = w.store.getMany.bind(w.store);
    w.store.getMany = async () => { throw new Error("throttled"); };
    expect((await erase(w)).evidence).toBe("owed");
    w.store.getMany = getMany;
    expect(await resumePersonErases(w.deps, A, 5_000)).toEqual({ finished: 1, owed: 0 });
  });

  it("a full retry list never stalls the walk: the earlier failures are retried first, and the walk then goes on", async () => {
    const w = world();
    const real = w.deps.objects;
    let failing = true;
    w.deps.objects = { deleteEveryVersion: async (prefix, options) => (failing ? false : await real.deleteEveryVersion(prefix, options)) };
    for (let i = 0; i < PERSON_ERASE_RETRY_MAX + 3; i += 1) await task(w, MALLORY, A);
    expect((await erase(w, { budgetMs: 60_000 })).evidence).toBe("owed");
    failing = false;
    expect(await resumePersonErases(w.deps, A, 60_000)).toEqual({ finished: 1, owed: 0 });
    expect(await w.store.get({ pk: personErasePendingPartition(A), sk: MALLORY })).toBeUndefined();
  });

  it("an empty page that still carries a cursor is not the end of the index", async () => {
    const w = world();
    const one = await task(w, MALLORY, A);
    const query = w.store.query.bind(w.store);
    let first = true;
    w.store.query = async (request) => {
      if (request.pk.startsWith("DEVELOPER#") && first) { first = false; return { items: [], cursor: "more" }; }
      if (request.cursor === "more") { const { cursor: _c, ...rest } = request; void _c; return await query(rest); }
      return await query(request);
    };
    expect(await erase(w)).toMatchObject({ evidence: "done", counts: { erased: 1 } });
    expect(left(w, one.prefixes)).toBe(0);
  });

  it("a prefix delete that ran out of time leaves the task owed, never counted erased", async () => {
    const w = world();
    await task(w, MALLORY, A);
    w.deps.objects = { deleteEveryVersion: async () => "out_of_time" };
    const receipt = await erase(w);
    expect(receipt).toMatchObject({ evidence: "owed", counts: { erased: 0, incomplete: 1 } });
  });

  it("a repeat never overwrites the saved cursor of an owed walk", async () => {
    const w = world();
    await task(w, MALLORY, A);
    await task(w, MALLORY, A);
    let calls = 0;
    const real = w.deps.objects;
    w.deps.objects = { deleteEveryVersion: async (prefix, options) => { calls += 1; const outcome = await real.deleteEveryVersion(prefix, options); if (calls === 2) w.clock.now += 10_000; return outcome; } };
    await erase(w, { budgetMs: 5_000 });
    const saved = (await w.store.get({ pk: personErasePendingPartition(A), sk: MALLORY }))?.["cursor"];
    expect(saved).toEqual(expect.any(String));
    await erase(w, { budgetMs: 0 });
    expect((await w.store.get({ pk: personErasePendingPartition(A), sk: MALLORY }))?.["cursor"]).toBe(saved);
  });

  it("a task whose ids are not plain ids is refused (counted), never retried, and does not hold the erase open", async () => {
    const w = world();
    await task(w, MALLORY, A, { record: { ownerKey: "../../escape" } });
    const receipt = await erase(w);
    expect(receipt).toMatchObject({ evidence: "done", counts: { refused: 1, erased: 0 } });
  });

  it("keeps at most PERSON_ERASE_RETRY_MAX failing tasks; the main walk then stops and is never done", async () => {
    const w = world();
    w.deps.objects = { deleteEveryVersion: async () => false };
    for (let i = 0; i < PERSON_ERASE_RETRY_MAX + 3; i += 1) await task(w, MALLORY, A);
    const receipt = await erase(w, { budgetMs: 60_000 });
    expect(receipt.evidence).toBe("owed");
    const pending = await w.store.get({ pk: personErasePendingPartition(A), sk: MALLORY });
    expect((pending?.["retry"] as unknown[]).length).toBe(PERSON_ERASE_RETRY_MAX);
    expect(pending?.["scanned"]).not.toBe(true);
  });

  it("the resume of one company never walks another company's pending erase", async () => {
    const w = world();
    const theirs = await task(w, MALLORY, B);
    await w.store.put({ item: { pk: personErasePendingPartition(B), sk: MALLORY, entityType: "PERSON_ERASE_PENDING" } });
    expect(await resumePersonErases(w.deps, A, 5_000)).toEqual({ finished: 0, owed: 0 });
    expect(left(w, theirs.prefixes)).toBe(10);
  });
});
