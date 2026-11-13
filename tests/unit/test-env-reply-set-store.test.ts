// TE-R1 part A: what the reply-set store service does that the shared conformance suite does not pin: the exact rows and keys, the expiry attribute, the write order and the one join transaction, a lost race, a changed row,
// the laptop's company, a sort key TE-G7 will own, and the paths a coding agent's file could take.
import { describe, expect, it } from "vitest";
import {
  DocumentStoreError,
  IMPLICIT_COMPANY_ID,
  INDEX_EXPIRY_ATTRIBUTE,
  REPLY_OVERLAY_TTL_DAYS,
  createRovaraIndependentDecision,
  modelReplyEntrySha256,
  queryAll,
  replyEntrySortKey,
  replyHeadSortKey,
  replyJoinSortKey,
  replyStorePartition,
  replyTaskSortKey,
  type DocumentStore,
  type ModelReplyFileEntry,
  type StoredDocument,
  type TransactItem,
} from "@agentx/contracts";
import { COMPANY_A, COMPANY_B } from "@agentx/testing";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createReplySetStore, type ReplySetStoreOptions } from "../../packages/broker/src/core/test-env/reply-set-store.js";

const A = COMPANY_A.scope;
const FAMILY = "gemini" as const;
const COMMIT = "d".repeat(40);
const PROJECT = "proj";
const reply = (id: string, text = `answer ${id}`, match: ModelReplyFileEntry["match"] = {}): ModelReplyFileEntry => ({ id, match, response: { text, finish: "stop" } });
const bytes = (replies: ModelReplyFileEntry[], family = FAMILY) => new TextEncoder().encode(JSON.stringify({ version: 1, family, replies }));
const q = (over: Record<string, string> = {}) => ({ project: PROJECT, branch: "feature/a#b", family: FAMILY, ...over });
const NOW = new Date("2026-11-13T12:00:00Z");

function world(over: Partial<ReplySetStoreOptions> = {}, store: DocumentStore = new MemoryDocumentStore({ ttlAttribute: INDEX_EXPIRY_ATTRIBUTE })) {
  const problems: string[] = [];
  const service = createReplySetStore({ store, now: () => NOW, onProblem: (code) => problems.push(code), ...over });
  const pk = replyStorePartition(COMPANY_A.orgId, PROJECT);
  const rows = async () => queryAll(store, { pk });
  return { store, service, problems, pk, rows };
}
const seed = (service: ReturnType<typeof world>["service"], replies: ModelReplyFileEntry[], over: Record<string, string> = {}) =>
  service.importFromRepoFile(A, { ...q(over), baseCommitSha: COMMIT, bytes: bytes(replies), origin: "customer_written" });

describe("rows and keys", () => {
  it("writes ORG#<company>#MOCKSET#<project> rows with the four sort-key kinds, the branch as a field and never raw in a key", async () => {
    const { service, rows, pk } = world();
    await seed(service, [reply("a")]);
    await service.putOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, replies: [reply("b")] });
    const all = await rows();
    const keys = all.map((row) => row.sk).sort();
    expect(keys).toEqual([replyEntrySortKey(modelReplyEntrySha256(reply("a"))), replyEntrySortKey(modelReplyEntrySha256(reply("b"))), replyHeadSortKey("feature/a#b", FAMILY), replyTaskSortKey("task-1", FAMILY)].sort());
    expect(all.every((row) => row.pk === pk)).toBe(true);
    expect(pk).toBe(`ORG#${COMPANY_A.orgId}#MOCKSET#${PROJECT}`);
    expect(keys.some((key) => key.includes("feature"))).toBe(false);
    const head = all.find((row) => row.sk.startsWith("HEAD#model#"))!;
    expect(head.branch).toBe("feature/a#b");
    expect(head.kind).toBe("model_replies");
  });
  it("puts the expiry attribute on the overlay and the join marker only, 30 days out; heads and bodies never expire", async () => {
    const { service, rows } = world();
    await seed(service, [reply("a")]);
    await service.putOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, replies: [reply("b")] });
    const expiry = Math.floor(NOW.getTime() / 1000) + REPLY_OVERLAY_TTL_DAYS * 86_400;
    const expiries = async (): Promise<Record<string, unknown>> => Object.fromEntries((await rows()).map((row): [string, unknown] => [row.sk.split("#")[0] ?? "", row[INDEX_EXPIRY_ATTRIBUTE]]));
    let byPrefix = await expiries();
    expect(byPrefix).toEqual({ HEAD: undefined, ENTRY: undefined, TASK: expiry });
    expect(INDEX_EXPIRY_ATTRIBUTE).toBe("indexExpiresAt");
    await service.joinTask(A, { project: PROJECT, taskId: "task-1", family: FAMILY, branch: "feature/a#b" });
    byPrefix = await expiries();
    expect(byPrefix).toEqual({ HEAD: undefined, ENTRY: undefined, JOIN: expiry });
  });
  it("keeps the company out of every row body: the company is only in the partition key", async () => {
    const { service, rows } = world();
    await seed(service, [reply("a")]);
    expect(JSON.stringify(await rows())).not.toContain(COMPANY_B.orgId);
    expect(JSON.stringify((await rows()).map((row) => ({ ...row, pk: undefined })))).not.toContain(COMPANY_A.orgId);
  });
  it("ignores a sort key this lane does not own (TE-G7's HEAD#service#, its own entries) in reads, lists, imports and erase", async () => {
    const { service, store, pk } = world();
    await store.put({ item: { pk, sk: "HEAD#service#payments", kind: "service_replies", secret: "g7-data" } });
    await store.put({ item: { pk, sk: "SVC#entry#1", kind: "g7_entry" } });
    expect(await service.listHeads(A, PROJECT)).toEqual({ ok: false, word: "not_found" });
    await seed(service, [reply("a")]);
    expect((await service.listHeads(A, PROJECT)).ok).toBe(true);
    expect((await service.readSet(A, q())).ok).toBe(true);
    expect(await service.eraseProject(A, { project: PROJECT })).toMatchObject({ ok: true });
    expect(await store.get({ pk, sk: "HEAD#service#payments" })).toMatchObject({ secret: "g7-data" });
    expect(await store.get({ pk, sk: "SVC#entry#1" })).toBeDefined();
    expect((await service.readSet(A, q())).ok).toBe(false);
  });
});

describe("write order and the one join transaction", () => {
  it("writes the bodies first, then the head", async () => {
    const memory = new MemoryDocumentStore({ ttlAttribute: INDEX_EXPIRY_ATTRIBUTE });
    const order: string[] = [];
    const spy: DocumentStore = Object.create(memory) as DocumentStore;
    Object.assign(spy, { put: async (request: Parameters<DocumentStore["put"]>[0]) => { order.push(request.item.sk.split("#")[0]!); return memory.put(request); }, getMany: (keys: Parameters<DocumentStore["getMany"]>[0]) => memory.getMany(keys), get: (key: Parameters<DocumentStore["get"]>[0]) => memory.get(key), query: (request: Parameters<DocumentStore["query"]>[0]) => memory.query(request), transact: (items: readonly TransactItem[]) => memory.transact(items), delete: (request: Parameters<DocumentStore["delete"]>[0]) => memory.delete(request), indexes: memory.indexes });
    const { service } = world({}, spy);
    await seed(service, [reply("a"), reply("b")]);
    expect(order).toEqual(["ENTRY", "ENTRY", "HEAD"]);
  });
  it("moves the head, writes the JOIN marker and removes the overlay in ONE transaction", async () => {
    const memory = new MemoryDocumentStore({ ttlAttribute: INDEX_EXPIRY_ATTRIBUTE });
    const transactions: TransactItem[][] = [];
    const spy = Object.assign(Object.create(memory) as DocumentStore, {
      put: (r: Parameters<DocumentStore["put"]>[0]) => memory.put(r), get: (k: Parameters<DocumentStore["get"]>[0]) => memory.get(k), getMany: (k: Parameters<DocumentStore["getMany"]>[0]) => memory.getMany(k),
      query: (r: Parameters<DocumentStore["query"]>[0]) => memory.query(r), delete: (r: Parameters<DocumentStore["delete"]>[0]) => memory.delete(r), indexes: memory.indexes,
      transact: (items: readonly TransactItem[]) => { transactions.push([...items]); return memory.transact(items); },
    });
    const { service } = world({}, spy);
    await service.putOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, replies: [reply("a")] });
    transactions.length = 0;
    await service.joinTask(A, { project: PROJECT, taskId: "task-1", family: FAMILY, branch: "main" });
    expect(transactions).toHaveLength(1);
    expect(transactions[0]!.map((item) => `${item.kind}:${("item" in item ? item.item.sk : "key" in item ? item.key.sk : "").split("#")[0]}`)).toEqual(["put:HEAD", "put:JOIN", "delete:TASK"]);
    expect(transactions[0]![0]).toMatchObject({ condition: { op: "notExists" } }); // a branch with no head: created only if still absent
    expect(transactions[0]![2]).toMatchObject({ condition: { op: "eq", path: ["revision"] } });
  });
  it("leaves nothing changed when the join transaction is refused by the store, and a later join works", async () => {
    const memory = new MemoryDocumentStore({ ttlAttribute: INDEX_EXPIRY_ATTRIBUTE });
    let fail = false;
    const flaky = Object.assign(Object.create(memory) as DocumentStore, {
      put: (r: Parameters<DocumentStore["put"]>[0]) => memory.put(r), get: (k: Parameters<DocumentStore["get"]>[0]) => memory.get(k), getMany: (k: Parameters<DocumentStore["getMany"]>[0]) => memory.getMany(k),
      query: (r: Parameters<DocumentStore["query"]>[0]) => memory.query(r), delete: (r: Parameters<DocumentStore["delete"]>[0]) => memory.delete(r), indexes: memory.indexes,
      transact: async (items: readonly TransactItem[]) => { if (fail) throw new DocumentStoreError("unavailable", "down"); return memory.transact(items); },
    });
    const { service } = world({}, flaky);
    await service.putOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, replies: [reply("a")] });
    fail = true;
    await expect(service.joinTask(A, { project: PROJECT, taskId: "task-1", family: FAMILY, branch: "main" })).rejects.toThrow(DocumentStoreError);
    expect((await service.readSet(A, { ...q(), branch: "main" })).ok).toBe(false);
    fail = false;
    expect(await service.joinTask(A, { project: PROJECT, taskId: "task-1", family: FAMILY, branch: "main" })).toMatchObject({ ok: true, status: "joined", added: 1 });
  });
});

describe("a lost race", () => {
  function racing(rivals: number) {
    const memory = new MemoryDocumentStore({ ttlAttribute: INDEX_EXPIRY_ATTRIBUTE });
    let remaining = rivals;
    const store = Object.assign(Object.create(memory) as DocumentStore, {
      get: (k: Parameters<DocumentStore["get"]>[0]) => memory.get(k), getMany: (k: Parameters<DocumentStore["getMany"]>[0]) => memory.getMany(k), query: (r: Parameters<DocumentStore["query"]>[0]) => memory.query(r),
      delete: (r: Parameters<DocumentStore["delete"]>[0]) => memory.delete(r), transact: (i: readonly TransactItem[]) => memory.transact(i), indexes: memory.indexes,
      put: async (request: Parameters<DocumentStore["put"]>[0]) => {
        if (request.item.sk.startsWith("HEAD#model#") && remaining > 0) {
          remaining -= 1;
          // somebody else moves the head between our read and our write
          const current = await memory.get({ pk: request.item.pk, sk: request.item.sk });
          await memory.put({ item: { ...(current ?? request.item), revision: ((current?.revision as number | undefined) ?? 0) + 1, entries: current?.entries ?? [], digest: current?.digest ?? request.item.digest } as StoredDocument });
        }
        return memory.put(request);
      },
    });
    return store;
  }
  it("retries once and succeeds when the head moved once", async () => {
    const { service } = world({}, racing(1));
    await seed(service, [reply("a")]);
    // the rival wrote an (empty) head first; our retry read it and wrote on top
    expect(await seed(service, [reply("b")])).toMatchObject({ ok: true });
    const read = await service.readSet(A, q());
    expect(read.ok && read.set.replies.map((entry) => entry.id)).toContain("b");
  });
  it("answers conflict, writing nothing more, when the head moved twice", async () => {
    const { service } = world({}, racing(2));
    expect(await seed(service, [reply("a")])).toEqual({ ok: false, word: "conflict" });
  });
});

describe("rows that no longer say what their key says are never served", () => {
  it("refuses a changed body, a missing body and a changed digest, with a fixed problem code and the same not_found", async () => {
    const { service, store, pk, problems } = world();
    await seed(service, [reply("a"), reply("b")]);
    const sha = modelReplyEntrySha256(reply("b"));
    const row = (await store.get({ pk, sk: replyEntrySortKey(sha) }))!;
    await store.put({ item: { ...row, body: { ...(row.body as object), response: { text: "tampered", finish: "stop" } } } });
    expect(await service.readSet(A, q())).toEqual({ ok: false, word: "not_found" });
    expect(problems).toContain("body_changed");
    await store.put({ item: row });
    expect((await service.readSet(A, q())).ok).toBe(true);
    await store.delete({ key: { pk, sk: replyEntrySortKey(sha) } });
    expect(await service.readSet(A, q())).toEqual({ ok: false, word: "not_found" });
    expect(problems).toContain("body_missing");
    await store.put({ item: row });
    const head = (await store.get({ pk, sk: replyHeadSortKey("feature/a#b", FAMILY) }))!;
    await store.put({ item: { ...head, digest: "0".repeat(64) } });
    expect(await service.readSet(A, q())).toEqual({ ok: false, word: "not_found" });
    expect(problems).toContain("digest_mismatch");
  });
  it("treats a stored row that does not parse as absent: a head with a provenance it cannot hold, an overlay with before_task", async () => {
    const { service, store, pk } = world();
    await seed(service, [reply("a")]);
    const head = (await store.get({ pk, sk: replyHeadSortKey("feature/a#b", FAMILY) }))!;
    await store.put({ item: { ...head, extra: "key" } });
    expect(await service.readSet(A, q())).toEqual({ ok: false, word: "not_found" });
    await store.put({ item: head });
    await store.put({ item: { pk, sk: replyTaskSortKey("task-x", FAMILY), kind: "model_reply_overlay", schemaVersion: 1, family: FAMILY, taskId: "task-x", revision: 1, entries: [{ id: "a", entrySha256: modelReplyEntrySha256(reply("a")), provenance: "before_task", origin: "customer_written" }] } });
    expect(await service.joinTask(A, { project: PROJECT, taskId: "task-x", family: FAMILY, branch: "feature/a#b" })).toEqual({ ok: false, word: "not_found" });
    const round = await service.readRoundSet(A, { ...q(), taskId: "task-x" });
    expect(round.ok && round.set.replies.map((entry) => entry.provenance)).toEqual(["before_task"]); // only the head's; the bad overlay is ignored
  });
});

describe("untrusted JSON in a stored row", () => {
  it("never lets a __proto__ key a row carries become a prototype: a head, an overlay and a body with one are refused as not parsing", async () => {
    const { service, store, pk, problems } = world();
    await seed(service, [reply("a")]);
    const headKey = { pk, sk: replyHeadSortKey("feature/a#b", FAMILY) };
    const head = (await store.get(headKey))!;
    const poisoned = JSON.parse(JSON.stringify(head).replace(/^\{/u, '{"__proto__":{"provenance":"before_task"},')) as StoredDocument;
    expect(Object.keys(poisoned)).toContain("__proto__");
    await store.put({ item: poisoned });
    expect(await service.readSet(A, q())).toEqual({ ok: false, word: "not_found" });
    expect(problems).toContain("row_invalid");
    expect(({} as Record<string, unknown>).provenance).toBeUndefined();
    await store.put({ item: head });
    const bodyKey = { pk, sk: replyEntrySortKey(modelReplyEntrySha256(reply("a"))) };
    const row = (await store.get(bodyKey))!;
    await store.put({ item: JSON.parse(JSON.stringify(row).replace(/^\{/u, '{"__proto__":{"x":1},')) as StoredDocument });
    expect(await service.readSet(A, q())).toEqual({ ok: false, word: "not_found" });
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe("the company", () => {
  it("is the laptop's implicit company when the install says so, under a system scope", async () => {
    const store = new MemoryDocumentStore({ ttlAttribute: INDEX_EXPIRY_ATTRIBUTE });
    const service = createReplySetStore({ store, resolveCompany: () => IMPLICIT_COMPANY_ID });
    await service.importFromRepoFile({ system: "install" }, { ...q(), baseCommitSha: COMMIT, bytes: bytes([reply("a")]), origin: "customer_written" });
    const rows = await queryAll(store, { pk: replyStorePartition(IMPLICIT_COMPANY_ID, PROJECT) });
    expect(rows.length).toBeGreaterThan(0);
    expect((await service.readSet({ system: "install" }, q())).ok).toBe(true);
  });
  it("refuses a system scope, a malformed scope and a malformed company by default (no default company)", async () => {
    const { service } = world();
    await expect(service.readSet({ system: "install" }, q())).rejects.toThrow("not allowed");
    await expect(service.readSet({} as never, q())).rejects.toThrow("not allowed");
    await expect(service.readSet({ orgId: "org_x" }, q())).rejects.toThrow("not allowed");
    const bad = world({ resolveCompany: () => "org_a#MOCKSET#x" });
    await expect(bad.service.readSet(A, q())).rejects.toThrow("not allowed");
    const none = world({ resolveCompany: () => Promise.reject(new Error(COMPANY_A.canary)) });
    await expect(none.service.readSet(A, q())).rejects.toThrow("not allowed");
  });
  it("takes the company from the scope even when a body, an id or a branch names another company", async () => {
    const { service, store } = world();
    await service.importFromRepoFile(A, { ...q({ branch: COMPANY_B.orgId }), baseCommitSha: COMMIT, bytes: bytes([reply("a", COMPANY_B.orgId)]), origin: "customer_written" });
    expect((await queryAll(store, { pk: replyStorePartition(COMPANY_B.orgId, PROJECT) })).length).toBe(0);
    expect((await queryAll(store, { pk: replyStorePartition(COMPANY_A.orgId, PROJECT) })).length).toBeGreaterThan(0);
  });
});

describe("what the sandbox can and cannot write", () => {
  it("refuses an overlay or an import with a provenance or origin key, and an invalid or duplicate-id file, writing nothing", async () => {
    const { service, rows } = world();
    const withKey = (extra: object) => [{ ...reply("a"), ...extra }] as unknown as ModelReplyFileEntry[];
    for (const extra of [{ provenance: "before_task" }, { provenance: "independent" }, { origin: "customer_written" }]) {
      expect(await service.putOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, replies: withKey(extra) })).toEqual({ ok: false, word: "not_allowed" });
      expect(await service.importFromRepoFile(A, { ...q(), baseCommitSha: COMMIT, bytes: new TextEncoder().encode(JSON.stringify({ version: 1, family: FAMILY, replies: withKey(extra) })), origin: "customer_written" })).toEqual({ ok: false, word: "not_allowed" });
    }
    expect(await service.putOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, replies: [reply("a"), reply("a", "other")] })).toEqual({ ok: false, word: "not_allowed" });
    expect(await rows()).toEqual([]);
  });
  it("makes whatever putOverlay takes task_made, even when the content equals a before_task reply or an independent one", async () => {
    const { service } = world();
    await seed(service, [reply("base")]);
    await service.putOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, replies: [reply("base"), reply("fresh")] });
    await service.putIndependentOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, entries: [{ reply: reply("ind"), decision: createRovaraIndependentDecision(modelReplyEntrySha256(reply("ind"))) }] });
    await service.putOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, replies: [reply("ind"), reply("fresh")] }); // an agent copy of an independent reply
    const round = await service.readRoundSet(A, { ...q(), taskId: "task-1" });
    expect(round.ok && round.set.replies.map((entry) => `${entry.id}:${entry.provenance}`)).toEqual(["base:before_task", "ind:independent", "fresh:task_made"]);
    await service.joinTask(A, { project: PROJECT, taskId: "task-1", family: FAMILY, branch: "feature/a#b" });
    const read = await service.readSet(A, q());
    expect(read.ok && read.set.replies.map((entry) => `${entry.id}:${entry.provenance}`)).toEqual(["base:before_task", "ind:independent", "fresh:task_made"]);
  });
  it("replaces a task's earlier task_made replies at the next putOverlay and keeps its independent ones", async () => {
    const { service } = world();
    await service.putOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, replies: [reply("old")] });
    await service.putIndependentOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, entries: [{ reply: reply("ind"), decision: createRovaraIndependentDecision(modelReplyEntrySha256(reply("ind"))) }] });
    await service.putOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, replies: [reply("new")] });
    const round = await service.readRoundSet(A, { ...q(), taskId: "task-1" });
    expect(round.ok && round.set.replies.map((entry) => entry.id)).toEqual(["ind", "new"]);
  });
  it("lets the base-commit file of a repo project reach before_task only through the explicit import: an edited file is task_made until then", async () => {
    const { service } = world();
    await seed(service, [reply("a")]);
    // a human edits the repo file outside Rovara: the candidate's unseen reply is the task's task_made overlay, never before_task
    await service.putOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, replies: [reply("a"), reply("hand-edited", "changed in the repo")] });
    const round = await service.readRoundSet(A, { ...q(), taskId: "task-1" });
    expect(round.ok && round.set.replies.map((entry) => `${entry.id}:${entry.provenance}`)).toEqual(["a:before_task", "hand-edited:task_made"]);
    await service.deleteOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY });
    // the next explicit import counts it
    expect(await seed(service, [reply("a"), reply("hand-edited", "changed in the repo")])).toMatchObject({ ok: true, added: 1 });
    const read = await service.readSet(A, q());
    expect(read.ok && read.set.replies.map((entry) => `${entry.id}:${entry.provenance}`)).toEqual(["a:before_task", "hand-edited:before_task"]);
  });
});

describe("caps", () => {
  it("refuses an overlay over 1,000 entries and a join that would pass 1,000 entries, changing nothing", async () => {
    const { service, rows } = world();
    const many = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => reply(`${prefix}${index}`));
    expect(await service.putOverlay(A, { project: PROJECT, taskId: "task-big", family: FAMILY, replies: many(1_001, "x") })).toEqual({ ok: false, word: "too_many" });
    expect(await rows()).toEqual([]);
    expect((await service.readRoundSet(A, { ...q(), taskId: "task-big" })).ok).toBe(false);
    await seed(service, many(999, "b"));
    await service.putOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, replies: [reply("e1"), reply("e2")] });
    expect(await service.joinTask(A, { project: PROJECT, taskId: "task-1", family: FAMILY, branch: "feature/a#b" })).toEqual({ ok: false, word: "too_many" });
    const read = await service.readSet(A, q());
    expect(read.ok && read.set.replies).toHaveLength(999);
    expect(await service.readRoundSet(A, { ...q(), taskId: "task-1" })).toMatchObject({ ok: true }); // the overlay is still there
    expect((await rows()).some((row) => row.sk === replyJoinSortKey("task-1", FAMILY))).toBe(false);
  });
  it("takes 1,000 replies and reads them back fast", async () => {
    const { service } = world();
    const replies = Array.from({ length: 1_000 }, (_, index) => reply(`r${index}`, `answer ${index} ${"x".repeat(500)}`));
    const started = performance.now();
    expect(await seed(service, replies)).toMatchObject({ ok: true, added: 1_000 });
    const read = await service.readSet(A, q());
    const elapsed = performance.now() - started;
    expect(read.ok && read.set.replies).toHaveLength(1_000);
    expect(elapsed).toBeLessThan(5_000);
  });
});
