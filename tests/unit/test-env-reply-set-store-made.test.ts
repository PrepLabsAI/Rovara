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

describe("H1: a reply the coding agent wrote is never imported as before_task (the durable MADE# record)", () => {
  it("expiry: 31 days after putOverlay the overlay is gone, and an import of the same content leaves it out", async () => {
    const { service, advance } = world();
    await importFile(service, [reply("base")]);
    await service.putOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, replies: [reply("hand", "agent wrote this")] });
    advance(31 * DAY);
    expect(await service.readRoundSet(A, { ...q, taskId: "task-1" })).toMatchObject({ ok: true }); // the head still reads; the overlay is gone
    expect(await importFile(service, [reply("base"), reply("hand", "agent wrote this")])).toMatchObject({ ok: true, added: 0, skipped: 2 });
    expect(await idsAndProvenance(service)).toEqual(["base:before_task"]);
  });
  it("deleteOverlay: after the overlay is deleted an import of the same content leaves it out", async () => {
    const { service } = world();
    await importFile(service, [reply("base")]);
    await service.putOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, replies: [reply("hand", "agent wrote this")] });
    await service.deleteOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY });
    expect(await importFile(service, [reply("hand", "agent wrote this")])).toMatchObject({ ok: true, added: 0, skipped: 1 });
    expect(await idsAndProvenance(service)).toEqual(["base:before_task"]);
  });
  it("a forced join failure (an id clash the agent builds from public hashes): the overlay never joins, and an import still leaves the reply out", async () => {
    const { service } = world();
    await importFile(service, [reply("a", "original")]);
    const x = reply("a", "agent edit");
    const y = reply(`a.edit-${sha(x).slice(0, 8)}`, "agent's decoy");
    await service.putOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, replies: [y, x] });
    expect(await service.joinTask(A, { project: PROJECT, taskId: "task-1", family: FAMILY, branch: BRANCH })).toEqual({ ok: false, word: "id_clash" });
    await service.deleteOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY });
    expect(await importFile(service, [x, y])).toMatchObject({ ok: true, added: 0, skipped: 2 });
    expect(await idsAndProvenance(service)).toEqual(["a:before_task"]);
  });
  it("a forced join failure by a full head (1,000 entries): the overlay never joins, and an import still leaves the reply out", async () => {
    const { service } = world();
    await importFile(service, Array.from({ length: 999 }, (_, index) => reply(`r${index}`)));
    await service.putOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, replies: [reply("e1", "agent"), reply("e2", "agent")] });
    expect(await service.joinTask(A, { project: PROJECT, taskId: "task-1", family: FAMILY, branch: BRANCH })).toEqual({ ok: false, word: "too_many" });
    await service.deleteOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY });
    expect(await importFile(service, [reply("e1", "agent")])).toMatchObject({ ok: true, added: 0, skipped: 1 });
    const read = await service.readSet(A, q);
    expect(read.ok && read.set.replies.some((entry) => entry.id === "e1")).toBe(false);
  });
  it("keeps the record through a join and a second task: the joined reply is task_made and an import of it adds nothing", async () => {
    const { service, store, pk } = world();
    await service.putOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, replies: [reply("hand")] });
    await service.joinTask(A, { project: PROJECT, taskId: "task-1", family: FAMILY, branch: BRANCH });
    expect(await importFile(service, [reply("hand")])).toMatchObject({ added: 0 });
    expect(await idsAndProvenance(service)).toEqual(["hand:task_made"]);
    expect((await queryAll(store, { pk, sk: { op: "beginsWith", prefix: "MADE#" } })).length).toBeGreaterThan(0);
  });
  it("only eraseProject removes the record, and MADE# is one of this lane's four-now-five prefixes", async () => {
    const { service, store, pk } = world();
    await service.putOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY, replies: [reply("hand")] });
    await service.deleteOverlay(A, { project: PROJECT, taskId: "task-1", family: FAMILY });
    expect((await queryAll(store, { pk, sk: { op: "beginsWith", prefix: "MADE#" } })).some((row) => row.sk.endsWith(sha(reply("hand"))))).toBe(true);
    expect(REPLY_STORE_OWN_PREFIXES).toContain("MADE#");
    await service.eraseProject(A, { project: PROJECT });
    expect(await queryAll(store, { pk })).toEqual([]);
    await importFile(service, [reply("hand")]); // after an erase the project is new: the import may count it
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
    expect(Object.keys(REPLY_STORE_WORDS).sort()).toEqual(["conflict", "id_clash", "not_allowed", "not_found", "too_large", "too_many"]);
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
