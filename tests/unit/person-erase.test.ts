// Person erase (row 13.1): the engine erase is company-scoped, records its receipt and audit event together, removes the person's chat links and learning data, and erases EVERY version of the
// evidence of the person's tasks in the company (DEC 212), bounded and resumable.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as codeModules from "../../packages/broker/src/core-host/code-modules.js";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { createFakeWorld } from "../support/core-host-fakes.js";
import { IMPLICIT_COMPANY_ID, orgChannelLinkKey, orgDeveloperChannelLinkKey, orgProjectCatalogKey, orgScoped, when, type AuditEvent, type AuditSink, type OrgId, type StoredDocument } from "@agentx/contracts";
import { TASK_FLOW_INDEXES } from "../../packages/broker/src/core/task-flow/flow.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { S3ObjectStorage } from "../../packages/aws-adapters/src/s3/index.js";
import { evidencePrefixesOf } from "../../packages/broker/src/core/proof/evidence-erase.js";
import { taskIndexKey, taskKey, taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import {
  PERSON_ERASE_RETRY_MAX, erasePerson, noLearningToErase, noWikiToErase, personErasePendingPartition, personErasedKey, resumePersonErases, unversionedEraseObjects, type PersonEraseDeps,
} from "../../packages/broker/src/core/people/erase.js";
import { VersionedBucket } from "../support/versioned-bucket.js";
import { prefsKey } from "../../packages/broker/src/core/notify/prefs.js";
import { notifySentKey } from "../../packages/broker/src/core/notify/attention.js";
import { inboxKey, inboxPartition, inboxRow } from "../../packages/broker/src/core/notify/inbox-rows.js";
import { githubLinkOf, linkGithubAccount, linkedGithubPerson } from "../../packages/broker/src/core/people/github-links.js";

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

interface World { store: MemoryDocumentStore; bucket: VersionedBucket; audit: ReturnType<typeof recordingAudit>; clock: { now: number }; deps: PersonEraseDeps; learning: string[]; wiki: string[]; logs: Record<string, unknown>[] }

function world(overrides: Partial<PersonEraseDeps> = {}): World {
  const store = new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES });
  const bucket = new VersionedBucket();
  const audit = recordingAudit();
  const clock = { now: Date.parse("2026-11-15T10:00:00.000Z") };
  const learning: string[] = [];
  const wiki: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const objects = new S3ObjectStorage({ client: bucket.client, bucket: "artifacts-a", now: () => clock.now });
  const deps: PersonEraseDeps = {
    store, audit, now: () => clock.now, log: (entry) => logs.push(entry),
    objects: { deleteEveryVersion: (prefix, options) => objects.deleteEveryVersion(prefix, options) },
    eraseLearning: async (companyId, personId) => { learning.push(`${companyId}/${personId}`); },
    eraseWiki: async (companyId, personId) => { wiki.push(`${companyId}/${personId}`); },
    ...overrides,
  };
  return { store, bucket, audit, clock, deps, learning, wiki, logs };
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

  it("walks past more than a page of another company's index rows, uncounted, to the person's own task after them", async () => {
    const w = world();
    for (let i = 0; i < 105; i += 1) {
      seq += 1;
      await w.store.put({ item: { ...taskIndexKey(MALLORY, new Date(Date.parse("2026-10-01T00:00:00.000Z") + i * 1000).toISOString(), `00000000-0000-4000-9000-${String(i).padStart(12, "0")}`), entityType: "DEVELOPER_TASK_INDEX", orgId: B } });
    }
    const own = await task(w, MALLORY, A);
    const receipt = await erase(w);
    expect(receipt).toMatchObject({ evidence: "done", counts: { tasks: 1, erased: 1, skipped: 0 } });
    expect(left(w, own.prefixes)).toBe(0);
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

  it("removes the person's in-app inbox rows in this company only, and nobody else's", async () => {
    const w = world();
    const session = `ses_${"a".repeat(20)}`;
    for (const company of [A, B]) for (const person of [MALLORY, "someone-else"]) await w.store.put({ item: inboxRow({ orgId: company, developerId: person, sessionId: session, kind: "needs_you", at: "2026-11-09T10:00:00.000Z", nowMs: Date.parse("2026-11-09T10:00:00.000Z") }) });
    await w.store.put({ item: inboxRow({ orgId: A, developerId: MALLORY, sessionId: `ses_${"b".repeat(20)}`, kind: "done", at: "2026-11-09T10:00:00.000Z", nowMs: Date.parse("2026-11-09T10:00:00.000Z") }) });
    await erase(w);
    expect((await w.store.query({ pk: inboxPartition(A, MALLORY) })).items).toEqual([]);
    expect(await w.store.get(inboxKey(B, MALLORY, session, "needs_you"))).toBeDefined();
    expect(await w.store.get(inboxKey(A, "someone-else", session, "needs_you"))).toBeDefined();
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

  it("removes the person's GitHub account link in this company (both rows), but not another person's, nor the same person's link in another company (L4-GH)", async () => {
    const w = world();
    const at = "2026-11-17T10:00:00.000Z";
    await linkGithubAccount(w.store, { companyId: A, githubUserId: "7", login: "mallory", personId: MALLORY, linkedAt: at });
    await linkGithubAccount(w.store, { companyId: A, githubUserId: "8", login: "other", personId: OTHER, linkedAt: at });
    await linkGithubAccount(w.store, { companyId: B, githubUserId: "7", login: "mallory", personId: MALLORY, linkedAt: at });
    await erase(w);
    expect(await githubLinkOf(w.store, A, MALLORY)).toBeUndefined();
    expect(await linkedGithubPerson(w.store, A, "7")).toBeUndefined();
    expect(await w.store.get({ pk: `ORG#${A}#GITHUB_ACCOUNT_OF`, sk: `PERSON#${MALLORY}` })).toBeUndefined();
    expect(await githubLinkOf(w.store, A, OTHER)).toMatchObject({ accountId: "8" });
    expect(await githubLinkOf(w.store, B, MALLORY)).toMatchObject({ accountId: "7" });
    // The erase is repeatable with the link already gone.
    await expect(erase(w)).resolves.toMatchObject({ alreadyErased: true });
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
    expect(await noWikiToErase()).toBeUndefined();
  });

  it("runs the wiki erase step for the person in this company (lead 4 W2)", async () => {
    const w = world();
    await erase(w);
    expect(w.wiki).toEqual([`${A}/${MALLORY}`]);
  });

  it("fails loudly when the wiki erase is not wired (never reads as nothing to erase)", async () => {
    const w = world({ eraseWiki: undefined as never });
    await expect(erase(w)).rejects.toThrow(/wiki erase hook is not wired/u);
    expect(w.audit.staged).toHaveLength(0);
  });

  it("a wiki erase that fails says so in fixed words, never its cause; the receipt stays and the walk stays owed", async () => {
    const w = world({ eraseWiki: async () => { throw new Error(`secret ${MALLORY} note text`); } });
    const failure = await erase(w).then(() => new Error("no failure"), (error: unknown) => error as Error);
    expect(failure.message).toMatch(/notes in the project wiki could not be cleared/u);
    expect(failure.message).not.toContain(MALLORY);
    expect(JSON.stringify(w.logs)).not.toContain(MALLORY);
    expect(await w.store.get(personErasedKey(A, MALLORY))).toBeDefined();
    expect(await w.store.get({ pk: personErasePendingPartition(A), sk: MALLORY })).toBeDefined();
  });

  it("the scheduled resume runs the wiki erase again before an owed walk, and skips the walk when it fails", async () => {
    const w = world();
    const real = w.deps.objects;
    w.deps.objects = { deleteEveryVersion: async () => { w.clock.now += 10_000; return "out_of_time" as const; } };
    await task(w, MALLORY, A);
    expect((await erase(w, { budgetMs: 5_000 })).evidence).toBe("owed");
    w.deps.objects = real;
    expect(await resumePersonErases({ ...w.deps, eraseWiki: async () => { throw new Error("wiki down"); } }, A, 5_000)).toEqual({ finished: 0, owed: 1 });
    const seen: string[] = [];
    expect(await resumePersonErases({ ...w.deps, eraseWiki: async (companyId, personId) => { seen.push(`${companyId}:${personId}`); } }, A, 5_000)).toEqual({ finished: 1, owed: 0 });
    expect(seen).toEqual([`${A}:${MALLORY}`]);
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

  it("with a learning erase given, runs it again before each owed walk; when it fails the walk is not run and the pending row stays for the next run", async () => {
    const w = world();
    const tasks = [await task(w, MALLORY, A), await task(w, MALLORY, A)];
    const real = w.deps.objects;
    w.deps.objects = { deleteEveryVersion: async () => { w.clock.now += 10_000; return "out_of_time" as const; } };
    expect((await erase(w, { budgetMs: 5_000 })).evidence).toBe("owed");
    w.deps.objects = real;
    const learning: string[] = [];
    const failing = async (companyId: string, personId: string) => { learning.push(`${companyId}:${personId}`); throw new Error("lessons store down"); };
    expect(await resumePersonErases({ ...w.deps, eraseLearning: failing }, A, 5_000)).toEqual({ finished: 0, owed: 1 });
    expect(left(w, tasks.flatMap((entry) => entry.prefixes))).toBeGreaterThan(0);
    expect(await w.store.get({ pk: personErasePendingPartition(A), sk: MALLORY })).toBeDefined();
    const working = async (companyId: string, personId: string) => { learning.push(`${companyId}:${personId}`); };
    expect(await resumePersonErases({ ...w.deps, eraseLearning: working }, A, 5_000)).toEqual({ finished: 1, owed: 0 });
    expect(learning).toEqual([`${A}:${MALLORY}`, `${A}:${MALLORY}`]);
    expect(left(w, tasks.flatMap((entry) => entry.prefixes))).toBe(0);
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

describe("scheduled person erase resume (L13)", () => {
  function scheduled(w: World, switchValue = `on:${A}`) {
    const fakes = createFakeWorld();
    const modules = fakes.modules.filter((module) => !["identity", "admission", "metering", "audit-sink", "approvers"].includes(module.point)).map((module) => {
      if (module.point === "storage") return { ...module, create: () => w.store };
      if (module.point === "object-storage") return { ...module, create: () => Object.assign(new S3ObjectStorage({ client: w.bucket.client, bucket: "artifacts-a", now: () => w.clock.now }), w.deps.objects) };
      return module;
    });
    const adapterModules = vi.spyOn(codeModules, "codeAdapterModules").mockReturnValue(modules);
    try {
      return createBrokerCoreRoot({
        env: { ROVARA_CORE_ENGINE: switchValue, ROVARA_CORE_ALLOWED_COMPANIES: "all" },
        documentClient: { send: async () => { throw new Error("unexpected sign-in read"); } }, stateTableName: "state", signInTableName: "signin",
        codeModules: () => ({} as codeModules.CodeModuleDeps),
        callbackSigningKey: "k".repeat(32), repositoryGrantKey: Buffer.alloc(32, 1), repositoryCredential: async () => { throw new Error("unused"); },
        origin: () => "https://example.invalid", now: () => new Date(w.clock.now), log: (entry) => w.logs.push(entry),
        services: () => Object.fromEntries(["merge-tracking", "session-sweep", "notify-deliver", "admission-hold-sweep"].map((name) => [name, { pass: async () => ({}) }])),
        ciReporting: { honest: true, ciMode: () => "their_ci_fix" },
      });
    } finally {
      // Registry construction is lazy; restore only after each test's job has run.
      restores.push(() => adapterModules.mockRestore());
    }
  }
  const restores: Array<() => void> = [];
  afterEach(() => { for (const restore of restores.splice(0)) restore(); });
  const event = { source: "agentx.core-job", job: "person-erase-resume" };
  const pending = (company: string, person = MALLORY) => ({ pk: personErasePendingPartition(company), sk: person, entityType: "PERSON_ERASE_PENDING" });

  it("a scheduled A pass erases A evidence but preserves B's pending row and evidence for the same raw person id", async () => {
    const w = world();
    const ours = await task(w, MALLORY, A);
    const theirs = await task(w, MALLORY, B);
    await w.store.put({ item: pending(A) });
    await w.store.put({ item: pending(B) });
    const before = JSON.stringify(await w.store.get(pending(B)));
    const root = scheduled(w);
    expect(await root.app.handleScheduledJob(event)).toMatchObject({ job: event.job, companies: [{ companyId: A, outcome: "ran", report: { finished: 1, owed: 0 } }] });
    expect(left(w, ours.prefixes)).toBe(0);
    expect(left(w, theirs.prefixes)).toBe(10);
    expect(await w.store.get(pending(A))).toBeUndefined();
    expect(JSON.stringify(await w.store.get(pending(B)))).toBe(before);
  });

  it("a failed real learning step preserves the pending row and evidence, leaks no cause, and retries next scheduled pass", async () => {
    const w = world();
    const ours = await task(w, MALLORY, A);
    await w.store.put({ item: pending(A) });
    const query = w.store.query.bind(w.store);
    let fail = true;
    const evidenceReads: string[] = [];
    w.store.query = async (request) => {
      if (request.pk.startsWith("DEVELOPER#")) evidenceReads.push(request.pk);
      if (fail && request.pk === orgProjectCatalogKey(A, "x").pk) throw new Error("confidential-learning-canary");
      return await query(request);
    };
    const root = scheduled(w);
    expect(await root.app.handleScheduledJob(event)).toMatchObject({ companies: [{ outcome: "ran", report: { finished: 0, owed: 1 } }] });
    expect(await w.store.get(pending(A))).toBeDefined();
    expect(left(w, ours.prefixes)).toBe(10);
    expect(evidenceReads).toEqual([]);
    expect(JSON.stringify(w.logs)).not.toContain("confidential-learning-canary");
    fail = false;
    expect(await root.app.handleScheduledJob(event)).toMatchObject({ companies: [{ report: { finished: 1, owed: 0 } }] });
    expect(await w.store.get(pending(A))).toBeUndefined();
    expect(left(w, ours.prefixes)).toBe(0);
    expect(evidenceReads.length).toBeGreaterThan(0);
  });

  it("caps a pass by the Lambda's remaining time and stops before the next pending person", async () => {
    const w = world();
    const first = await task(w, MALLORY, A);
    const second = await task(w, OTHER, A);
    await w.store.put({ item: pending(A) });
    await w.store.put({ item: pending(A, OTHER) });
    const real = w.deps.objects;
    const deadline = w.clock.now + 100;
    const stops: Array<number | undefined> = [];
    w.deps.objects = { deleteEveryVersion: async (prefix, options) => {
      stops.push(options.stopAt);
      const result = await real.deleteEveryVersion(prefix, options);
      w.clock.now += 100;
      return result;
    } };
    const root = scheduled(w);
    expect(await root.app.handleScheduledJob(event, { remainingMs: 20_100 })).toMatchObject({ companies: [{ report: { owed: 2 } }] });
    expect(stops.length).toBeGreaterThan(0);
    for (const stop of stops) expect(stop).toBeLessThanOrEqual(deadline);
    expect(left(w, first.prefixes)).toBe(0);
    expect(left(w, second.prefixes)).toBe(10);
    expect(await w.store.get(pending(A, OTHER))).toBeDefined();
  });

  it("off jobs are byte-identical and leave seeded erases and evidence untouched", async () => {
    const w = world();
    const ours = await task(w, MALLORY, A);
    await w.store.put({ item: pending(A) });
    const root = scheduled(w, "off");
    expect(JSON.stringify(await root.app.handleScheduledJob(event))).toBe('{"skipped":"off"}');
    expect(await w.store.get(pending(A))).toEqual(pending(A));
    expect(left(w, ours.prefixes)).toBe(10);
  });
});
