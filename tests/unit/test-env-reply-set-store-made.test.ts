// TE-R1 part A review fixes (Opus review of #527): the durable MADE# record. A reply the coding agent ever wrote can never be imported as before_task/customer_written, whatever happens to its overlay
// (expiry, deleteOverlay, a join that fails), and an import cannot race a concurrent overlay write. Plus the fixed word for an id clash, the independent-overlay count, expired-but-unswept rows, and an invalid head failing the import closed.
import { describe, expect, it } from "vitest";
import {
  INDEX_EXPIRY_ATTRIBUTE,
  REPLY_STORE_OWN_PREFIXES,
  REPLY_STORE_WORDS,
  modelReplyEntrySha256,
  queryAll,
  replyHeadSortKey,
  replyJoinSortKey,
  replyStorePartition,
  type DocumentStore,
  type ModelReplyFileEntry,
  type TransactItem,
} from "@agentx/contracts";
import { createRovaraIndependentDecision } from "@agentx/contracts/independent-channel";
import { COMPANY_A } from "@agentx/testing";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createReplySetStore } from "../../packages/broker/src/core/test-env/reply-set-store.js";

const A = COMPANY_A.scope;
const FAMILY = "gemini" as const;
const PROJECT = "proj";
const BRANCH = "main";
const DAY = 86_400_000;
const reply = (id: string, text = `answer ${id}`): ModelReplyFileEntry => ({ id, match: {}, response: { text, finish: "stop" } });
const sha = (entry: ModelReplyFileEntry): string => modelReplyEntrySha256(entry);
const bytes = (replies: ModelReplyFileEntry[]) => new TextEncoder().encode(JSON.stringify({ version: 1, family: FAMILY, replies }));
const q = { project: PROJECT, branch: BRANCH, family: FAMILY };

function world(store: DocumentStore = new MemoryDocumentStore({ ttlAttribute: INDEX_EXPIRY_ATTRIBUTE })) {
  let clock = new Date("2026-11-13T12:00:00Z");
  const problems: string[] = [];
  const service = createReplySetStore({ store, now: () => clock, onProblem: (code) => problems.push(code) });
  const pk = replyStorePartition(COMPANY_A.orgId, PROJECT);
  return { store, service, problems, pk, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}
type World = ReturnType<typeof world>["service"];
const importFile = (service: World, replies: ModelReplyFileEntry[]) => service.importFromRepoFile(A, { ...q, baseCommitSha: "e".repeat(40), bytes: bytes(replies), origin: "customer_written" });
const idsAndProvenance = async (service: World) => {
  const read = await service.readSet(A, q);
  return read.ok ? read.set.replies.map((entry) => `${entry.id}:${entry.provenance}`) : [];
};

// The four H1 probes (expiry, deleteOverlay, a failed join by id clash, a full head) live in the shared conformance suite, so Cloud must pass them too.
describe("H1: the durable MADE# record (Code-only parts)", () => {
  it("keeps the record through a join and a second task: the joined reply is task_made and an import of it adds nothing", async () => {
    const { service, store, pk } = world();
    await service.putOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, replies: [reply("hand")] });
    await service.joinTask(A, { project: PROJECT, taskId: "task-1", family: FAMILY, branch: BRANCH });
    expect(await importFile(service, [reply("hand")])).toMatchObject({ added: 0 });
    expect(await idsAndProvenance(service)).toEqual(["hand:task_made"]);
    expect((await queryAll(store, { pk, sk: { op: "beginsWith", prefix: "MADE#" } })).length).toBeGreaterThan(0);
  });
  it("only eraseProject removes the record, and it leaves a content-free tombstone that stops imports until cleared", async () => {
    const { service, store, pk } = world();
    await service.putOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, replies: [reply("hand")] });
    await service.deleteOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY });
    expect((await queryAll(store, { pk, sk: { op: "beginsWith", prefix: "MADE#" } })).some((row) => row.sk.endsWith(sha(reply("hand"))))).toBe(true);
    expect(REPLY_STORE_OWN_PREFIXES).toContain("MADE#");
    await service.eraseProject(A, { project: PROJECT });
    const left = await queryAll(store, { pk });
    expect(left.map((row) => row.sk)).toEqual(["ERASED#project"]);
    expect(Object.keys(left[0]!).sort()).toEqual(["at", "kind", "pk", "schemaVersion", "sk"]); // content-free: a time and a kind
    expect(REPLY_STORE_OWN_PREFIXES.some((prefix) => "ERASED#project".startsWith(prefix))).toBe(false); // erase never deletes its own tombstone
    expect(await importFile(service, [reply("hand")])).toEqual({ ok: false, word: "erased" });
    expect(await service.clearErasure(A, { project: PROJECT })).toEqual({ ok: true });
    expect(await queryAll(store, { pk })).toEqual([]);
    await importFile(service, [reply("hand")]); // the maintainer accepted: the project is new
    expect(await idsAndProvenance(service)).toEqual(["hand:before_task"]);
  });
  it("does not record independent replies (they are not the coding agent's)", async () => {
    const { service, store, pk } = world();
    const ind = reply("ind");
    await service.putIndependentOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, entries: [{ reply: ind, decision: createRovaraIndependentDecision(sha(ind)) }] });
    expect((await queryAll(store, { pk, sk: { op: "beginsWith", prefix: "MADE#" } })).some((row) => row.sk.endsWith(sha(ind)))).toBe(false);
  });
});

describe("M1: an import cannot race a concurrent overlay write", () => {
  it("retries and leaves the reply out when a putOverlay of the same content commits between the import's reads and its write", async () => {
    const memory = new MemoryDocumentStore({ ttlAttribute: INDEX_EXPIRY_ATTRIBUTE });
    const racer: { run?: () => Promise<unknown> } = {};
    let fired = false;
    const store = Object.assign(Object.create(memory) as DocumentStore, {
      get: (k: Parameters<DocumentStore["get"]>[0]) => memory.get(k), getMany: (k: Parameters<DocumentStore["getMany"]>[0]) => memory.getMany(k), query: (r: Parameters<DocumentStore["query"]>[0]) => memory.query(r),
      put: (r: Parameters<DocumentStore["put"]>[0]) => memory.put(r), delete: (r: Parameters<DocumentStore["delete"]>[0]) => memory.delete(r), indexes: memory.indexes,
      transact: async (items: readonly TransactItem[]) => {
        if (!fired && racer.run !== undefined && items.some((item) => item.kind === "put" && item.item.sk.startsWith("HEAD#model#"))) {
          fired = true;
          await racer.run(); // the agent's overlay write lands after the import read the record and before the import writes
        }
        return memory.transact(items);
      },
    });
    const { service } = world(store);
    racer.run = () => service.putOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, replies: [reply("hand", "agent wrote this")] });
    const outcome = await importFile(service, [reply("base"), reply("hand", "agent wrote this")]);
    expect(fired).toBe(true);
    expect(outcome).toMatchObject({ ok: true, added: 1, skipped: 1 });
    expect(await idsAndProvenance(service)).toEqual(["base:before_task"]);
  });
});

describe("L1 and L2: fixed words", () => {
  it("putIndependentOverlay reports how many it added and names the skipped ones with a fixed reason", async () => {
    const { service } = world();
    const one = reply("one");
    const two = reply("two");
    const entry = (r: ModelReplyFileEntry) => ({ reply: r, decision: createRovaraIndependentDecision(sha(r)) });
    expect(await service.putIndependentOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, entries: [entry(one)] })).toEqual({ ok: true, stored: 1, skipped: [] });
    expect(await service.putIndependentOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, entries: [entry(one), entry(two)] })).toEqual({ ok: true, stored: 1, skipped: [{ id: "one", reason: "already_in_overlay" }] });
    expect(await service.putIndependentOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, entries: [entry(one), entry(two)] })).toEqual({ ok: true, stored: 0, skipped: [{ id: "one", reason: "already_in_overlay" }, { id: "two", reason: "already_in_overlay" }] });
  });
  it("an id clash has its own fixed word, not conflict", () => {
    expect(Object.keys(REPLY_STORE_WORDS).sort()).toEqual(["conflict", "erased", "id_clash", "made_full", "not_allowed", "not_found", "too_large", "too_many"]);
    expect(REPLY_STORE_WORDS.id_clash).not.toBe(REPLY_STORE_WORDS.conflict);
  });
});

describe("L3: an expired but unswept TASK#/JOIN# row is absent for writes too", () => {
  it("rewrites an overlay after 30 days before any sweep", async () => {
    const { service, advance } = world();
    await service.putOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, replies: [reply("old")] });
    advance(31 * DAY);
    expect(await service.putOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, replies: [reply("new")] })).toMatchObject({ ok: true, stored: 1 });
    const round = await service.readRoundSet(A, { ...q, taskId: "task-1" });
    expect(round.ok && round.set.replies.map((entry) => entry.id)).toEqual(["new"]);
  });
  it("rewrites a join marker after 30 days: the task can write and join again", async () => {
    const { service, advance, store, pk } = world();
    await service.putOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, replies: [reply("one")] });
    expect(await service.joinTask(A, { project: PROJECT, taskId: "task-1", family: FAMILY, branch: BRANCH })).toMatchObject({ status: "joined" });
    advance(31 * DAY);
    expect(await store.get({ pk, sk: replyJoinSortKey("task-1", FAMILY) })).toBeDefined(); // not swept
    expect(await service.putOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, replies: [reply("two")] })).toMatchObject({ ok: true });
    expect(await service.joinTask(A, { project: PROJECT, taskId: "task-1", family: FAMILY, branch: BRANCH })).toMatchObject({ ok: true, status: "joined", added: 1 });
    expect(await idsAndProvenance(service)).toEqual(["one:task_made", "two:task_made"]);
  });
});

describe("L4: an invalid head row stops an import (fail closed)", () => {
  it("imports nothing and reports a problem when any head of the project does not parse", async () => {
    const { service, store, pk, problems } = world();
    await importFile(service, [reply("base")]);
    const head = (await store.get({ pk, sk: replyHeadSortKey(BRANCH, FAMILY) }))!;
    await store.put({ item: { ...head, sk: replyHeadSortKey("other-branch", FAMILY), extra: "key" } });
    expect(await importFile(service, [reply("more")])).toEqual({ ok: false, word: "not_found" });
    expect(problems).toContain("row_invalid");
    expect(await idsAndProvenance(service)).toEqual(["base:before_task"]);
  });
  it("also refuses when a MADE# row does not parse", async () => {
    const { service, store, pk } = world();
    await service.putOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, replies: [reply("hand")] });
    await store.put({ item: { pk, sk: `MADE#${sha(reply("junk"))}`, kind: "model_reply_made", schemaVersion: 1, entrySha256: sha(reply("junk")), extra: 1 } });
    expect(await importFile(service, [reply("more")])).toEqual({ ok: false, word: "not_found" });
  });
});

describe("record before refusing (item 2) and content-equal variants (item 3): the rows", () => {
  it("records the entry hash and the content hash of a reply even when the write is refused", async () => {
    const { service, store, pk } = world();
    await service.putOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, replies: [reply("one")] });
    await service.joinTask(A, { project: PROJECT, taskId: "task-1", family: FAMILY, branch: BRANCH });
    expect(await service.putOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, replies: [reply("late")] })).toEqual({ ok: false, word: "not_allowed" });
    const keys = (await queryAll(store, { pk, sk: { op: "beginsWith", prefix: "MADE#" } })).map((row) => row.sk);
    expect(keys).toContain(`MADE#${sha(reply("late"))}`);
    expect(keys.filter((key) => key.startsWith("MADE#c#"))).toHaveLength(2);
  });
  it("does not mind the id or an empty toolCalls: the same answer under another id is skipped", async () => {
    const { service } = world();
    await service.putOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, replies: [reply("one", "same answer")] });
    const variant = { id: "two", match: {}, response: { text: "same answer", finish: "stop", toolCalls: [] } } as ModelReplyFileEntry;
    expect(await importFile(service, [variant])).toMatchObject({ ok: true, added: 0, skipped: 1 });
  });
});

describe("item 5: the MADE growth cap", () => {
  it("refuses a putOverlay that would pass the per-project cap with made_full, changing nothing, and also stops imports (the record may be incomplete)", async () => {
    const store = new MemoryDocumentStore({ ttlAttribute: INDEX_EXPIRY_ATTRIBUTE });
    const service = createReplySetStore({ store, now: () => new Date("2026-11-13T12:00:00Z"), madeLimit: 6 });
    const pk = replyStorePartition(COMPANY_A.orgId, PROJECT);
    expect(await service.putOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, replies: [reply("a"), reply("b")] })).toMatchObject({ ok: true }); // 4 rows
    const before = await queryAll(store, { pk });
    expect(await service.putOverlay(A, { project: PROJECT, taskId: "task-2", family: FAMILY, replies: [reply("c"), reply("d")] })).toEqual({ ok: false, word: "made_full" });
    expect(await queryAll(store, { pk })).toEqual(before);
    expect(await service.putOverlay(A, { project: PROJECT, taskId: "task-2", family: FAMILY, replies: [reply("a")] })).toMatchObject({ ok: true }); // nothing new to record
    expect(await service.putOverlay(A, { project: PROJECT, taskId: "task-3", family: FAMILY, replies: [reply("e")] })).toMatchObject({ ok: true }); // 6 rows: at the cap
    expect(await service.putOverlay(A, { project: PROJECT, taskId: "task-4", family: FAMILY, replies: [reply("f")] })).toEqual({ ok: false, word: "made_full" });
    expect(await service.importFromRepoFile(A, { ...q, baseCommitSha: "e".repeat(40), bytes: bytes([reply("z")]), origin: "customer_written" })).toEqual({ ok: false, word: "made_full" });
  });
  it("reads the record in pages (no unbounded query) and still finds every hash", async () => {
    const memory = new MemoryDocumentStore({ ttlAttribute: INDEX_EXPIRY_ATTRIBUTE });
    const limits: (number | undefined)[] = [];
    const store = Object.assign(Object.create(memory) as DocumentStore, {
      get: (k: Parameters<DocumentStore["get"]>[0]) => memory.get(k), getMany: (k: Parameters<DocumentStore["getMany"]>[0]) => memory.getMany(k), put: (r: Parameters<DocumentStore["put"]>[0]) => memory.put(r),
      delete: (r: Parameters<DocumentStore["delete"]>[0]) => memory.delete(r), transact: (i: readonly TransactItem[]) => memory.transact(i), indexes: memory.indexes,
      query: (r: Parameters<DocumentStore["query"]>[0]) => { if (r.sk?.op === "beginsWith" && r.sk.prefix === "MADE#") limits.push(r.limit); return memory.query(r); },
    });
    const service = createReplySetStore({ store, now: () => new Date("2026-11-13T12:00:00Z") });
    const many = Array.from({ length: 30 }, (_, index) => reply(`r${index}`, `text ${index}`));
    await service.putOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, replies: many });
    expect(await service.importFromRepoFile(A, { ...q, baseCommitSha: "e".repeat(40), bytes: bytes(many), origin: "customer_written" })).toMatchObject({ ok: true, added: 0, skipped: 30 });
    expect(limits.length).toBeGreaterThan(0);
    expect(limits.every((limit) => typeof limit === "number" && limit <= 1_000)).toBe(true);
  });
});
