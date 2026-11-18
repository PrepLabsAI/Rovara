// L4-LM1c: the producer of the human-edit job. A person's push to a Rovara pull request queues ONE job of ids for the head; a bot's push, another company's, a head already dealt with, a huge diff and a project
// whose learning is off queue nothing and (where it matters) read nothing from the code host.
import { describe, expect, it } from "vitest";
import type { ChangeRequestFile, CodeHost, CommitChanges, CommitIdentity, OrgId, PageBudget } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import type { HumanEditPush } from "../../../packages/broker/src/core/merge/seams.js";
import type { TaskRecord } from "../../../packages/broker/src/core/task-flow/records.js";
import { createHumanEditProducer, humanEditRequestId, humanEditRowKey, type HumanEditProducerDeps } from "../../../packages/broker/src/lessons/human-edit-producer.js";
import { HUMAN_EDIT_LINES_MAX } from "../../../packages/broker/src/lessons/human-edit-read.js";
import { HUMAN_EDIT_PRODUCER_REQUESTS_MAX } from "../../../packages/broker/src/lessons/human-edit-producer.js";
import { HumanEditMessageSchema, parseHumanEditMessage, type ReflectQueue, type ReflectQueueMessage } from "../../../packages/broker/src/lessons/reflect-queue.js";
import { settings } from "./lesson-helpers.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const sha = (n: number): string => n.toString(16).padStart(40, "0");
const BASE = sha(1);
const URL = "https://github.com/acme/api/pull/7";
const EDIT = ["@@ -1,3 +1,3 @@ function load()", "-for (;;) { try { fetch() } catch {} }", "+await withRetry(() => fetch())", "+await withRetry(() => save())"].join("\n");
const file = (path: string, additions: number, deletions: number, patch?: string): ChangeRequestFile => ({ path, status: "modified", additions, deletions, ...(patch === undefined ? {} : { patch }) });
const acct = (login: string, id: string, accountType: "person" | "bot" = "person") => ({ login, hostUserId: id, accountType });
const person: CommitIdentity = { author: acct("rae", "1001"), committer: acct("rae", "1001"), webFlow: false };
const bot: CommitIdentity = { author: acct("rovara[bot]", "9001", "bot"), committer: acct("rovara[bot]", "9001", "bot"), webFlow: false };
const commit = (parents: string[], identity: CommitIdentity, files: ChangeRequestFile[] = [file("src/fetch.ts", 2, 1, EDIT)], complete = true): CommitChanges => ({ files, complete, parents, identity });

function setup(over: { table?: Record<string, CommitChanges>; mode?: "Off" | "Collect" | "Suggest" | "On"; enabled?: boolean; canPlace?: boolean; queueFails?: { count: number }; identity?: boolean } = {}) {
  const table = over.table ?? { [sha(2)]: commit([BASE], person) };
  const asked: string[] = [];
  let identityReads = 0;
  const codeHost = {
    kind: "github", provider: "github",
    commitChanges: async (_repo: unknown, revision: string, _scope: unknown, budget?: PageBudget) => { budget?.beforeRequest(); asked.push(revision); const found = table[revision]; if (found === undefined) throw new Error("no such commit"); return found; },
    repositoryIdentity: async () => { identityReads += 1; return over.identity === false ? undefined : { id: "4242", fullName: "acme/api", defaultBranch: "main", private: true }; },
  } as unknown as CodeHost;
  const store = new MemoryDocumentStore({ ttlAttribute: "indexExpiresAt" });
  const sent: ReflectQueueMessage[] = [];
  const queue: ReflectQueue = { async send(message) { if ((over.queueFails?.count ?? 0) > 0) { over.queueFails!.count -= 1; throw new Error("the queue is down"); } sent.push(message); } };
  const logs: string[] = [];
  const tasks = new Map<string, TaskRecord>([["task-1", { taskId: "task-1", companyId: A, project: "payments" } as unknown as TaskRecord]]);
  const deps: HumanEditProducerDeps = {
    companyId: A, store, settings: settings({ mode: over.mode ?? "Suggest" }), enabled: () => over.enabled !== false, canPlaceAuthors: () => over.canPlace !== false,
    ownTask: async (taskId) => { const found = tasks.get(taskId); return found?.companyId === A ? found : undefined; },
    queue: async () => queue, now: () => Date.parse("2026-11-17T10:00:00.000Z"), log: (event) => { logs.push(event); },
  };
  const push = (head = sha(2), extra: Partial<HumanEditPush> = {}): HumanEditPush => ({
    task: { taskId: "task-1", orgId: A, project: "payments" } as HumanEditPush["task"], pullRequest: { repositoryId: "api", number: 7, url: URL },
    repository: { url: "https://github.com/acme/api", codeHost, scope: { orgId: A } }, base: BASE, head, headRef: "agentx/branch", ...extra,
  });
  return { produce: createHumanEditProducer(deps), push, sent, asked, logs, store, tasks, identityReads: () => identityReads };
}

describe("a person's push to a Rovara pull request", () => {
  it("queues one human-edit job of ids and fixed words for the head, under the task's company", async () => {
    const w = setup();
    expect(await w.produce(w.push())).toBe("queued");
    expect(w.sent).toHaveLength(1);
    const message = HumanEditMessageSchema.parse(w.sent[0]);
    expect(message).toMatchObject({
      kind: "human_edit", orgId: A, taskId: "task-1", project: "payments", requestId: humanEditRequestId("task-1", sha(2)), pullRequest: { number: 7, url: URL },
      candidateHeadSha: BASE, headSha: sha(2), headRef: "agentx/branch", repo: { host: "github", id: "4242", fullName: "acme/api", isPrivate: true, defaultBranch: "main" },
    });
    // The queue's own parser takes it, and nothing of the edit rides in it: no lines, no file names, no names of people.
    expect(parseHumanEditMessage(JSON.stringify(w.sent[0]))).toEqual(message);
    const text = JSON.stringify(w.sent[0]);
    for (const word of ["withRetry", "fetch.ts", "rae", "1001"]) expect(text).not.toContain(word);
  });

  it("queues once for a head however many passes see it, and a new head by a person is its own job", async () => {
    const w = setup({ table: { [sha(2)]: commit([BASE], person), [sha(3)]: commit([sha(2)], person, [file("src/save.ts", 2, 1, EDIT)]) } });
    expect(await w.produce(w.push())).toBe("queued");
    const readsAfterFirst = w.asked.length;
    expect(await w.produce(w.push())).toBe("already");
    expect(await w.produce(w.push())).toBe("already");
    expect(w.sent).toHaveLength(1);
    // A head already dealt with is not read again from the host.
    expect(w.asked).toHaveLength(readsAfterFirst);
    expect(await w.produce(w.push(sha(3)))).toBe("queued");
    expect(w.sent.map((message) => (message as { headSha: string }).headSha)).toEqual([sha(2), sha(3)]);
  });
  it("two racing passes queue one: the claim row is taken once", async () => {
    const w = setup();
    const results = await Promise.all([w.produce(w.push()), w.produce(w.push())]);
    expect(results.filter((result) => result === "queued")).toHaveLength(1);
    expect(w.sent).toHaveLength(1);
  });

  it("keeps a row for the head in the company's own partition, with the store's expiry", async () => {
    const w = setup();
    await w.produce(w.push());
    const row = await w.store.get(humanEditRowKey(A, "task-1", sha(2)));
    expect(row).toMatchObject({ entityType: "LESSON_HUMAN_EDIT", state: "queued", taskId: "task-1" });
    expect(typeof row?.["indexExpiresAt"]).toBe("number");
    expect(humanEditRowKey(A, "task-1", sha(2)).pk).not.toBe(humanEditRowKey(B, "task-1", sha(2)).pk);
  });
});

describe("what is ignored", () => {
  it("a bot's push: nothing is queued, and the head is recorded as judged so it is not read again", async () => {
    const w = setup({ table: { [sha(2)]: commit([BASE], bot) } });
    expect(await w.produce(w.push())).toBe("skipped");
    expect(w.sent).toEqual([]);
    expect(await w.store.get(humanEditRowKey(A, "task-1", sha(2)))).toMatchObject({ state: "skipped", reason: "no_person_commit" });
    const reads = w.asked.length;
    expect(await w.produce(w.push())).toBe("already");
    expect(w.asked).toHaveLength(reads);
  });

  it("a mixed push queues one job for the head (the worker reads only the person's commits)", async () => {
    const w = setup({ table: { [sha(2)]: commit([BASE], person), [sha(3)]: commit([sha(2)], bot, [file("src/bot.ts", 3, 0, EDIT)]) } });
    expect(await w.produce(w.push(sha(3)))).toBe("queued");
    expect(w.sent).toHaveLength(1);
  });

  it("another company's push: the task is not this company's, so nothing is read and nothing is queued", async () => {
    const w = setup();
    expect(await w.produce(w.push(sha(2), { task: { taskId: "task-1", orgId: B, project: "payments" } as HumanEditPush["task"] }))).toBe("other_company");
    // The producer's own company check on the record: a task id of another company reads as absent.
    w.tasks.set("task-1", { taskId: "task-1", companyId: B, project: "payments" } as unknown as TaskRecord);
    expect(await w.produce(w.push())).toBe("other_company");
    // A project the record does not have is not this company's task either.
    w.tasks.set("task-1", { taskId: "task-1", companyId: A, project: "other-project" } as unknown as TaskRecord);
    expect(await w.produce(w.push())).toBe("other_company");
    expect(w.sent).toEqual([]);
    expect(w.asked).toEqual([]);
  });

  it("a huge diff is skipped with a fixed reason and queues nothing", async () => {
    const w = setup({ table: { [sha(2)]: commit([BASE], person, [file("src/a.ts", HUMAN_EDIT_LINES_MAX + 1, 0, EDIT)]) } });
    expect(await w.produce(w.push())).toBe("skipped");
    expect(w.sent).toEqual([]);
    expect(await w.store.get(humanEditRowKey(A, "task-1", sha(2)))).toMatchObject({ state: "skipped", reason: "diff_too_large" });
    expect(w.logs).toContain("human_edit_skipped");
  });

  it("a head that takes more requests than the producer's allowance to read is too large: recorded as judged, never read again, nothing queued", async () => {
    const chain = 12;
    const table: Record<string, CommitChanges> = {};
    for (let n = 0; n < chain; n += 1) table[sha(100 + n)] = commit([n === chain - 1 ? BASE : sha(101 + n)], bot, [file(`src/f${String(n)}.ts`, 2, 1, EDIT)]);
    const w = setup({ table });
    // The host asks the budget once for each of three pages of a commit.
    const host = w.push(sha(100)).repository.codeHost as unknown as { commitChanges: (...args: unknown[]) => Promise<CommitChanges> };
    const original = host.commitChanges;
    host.commitChanges = async (r, revision, s, budget) => { for (let page = 0; page < 3; page += 1) (budget as PageBudget).beforeRequest(); return original(r, revision, s, undefined); };
    expect(chain * 3).toBeGreaterThan(HUMAN_EDIT_PRODUCER_REQUESTS_MAX);
    expect(await w.produce(w.push(sha(100)))).toBe("skipped");
    expect(await w.store.get(humanEditRowKey(A, "task-1", sha(100)))).toMatchObject({ state: "skipped", reason: "diff_too_large" });
    expect(await w.produce(w.push(sha(100)))).toBe("already");
    expect(w.sent).toEqual([]);
  });

  it("the pass's own stop (its allowance or the host's rate limit) is not a judgement: it goes up and nothing is recorded", async () => {
    const w = setup();
    const stop = new Error("the pass used its allowance");
    await expect(w.produce(w.push(sha(2), { budget: { beforeRequest: () => { throw stop; } } }))).rejects.toBe(stop);
    expect(await w.store.get(humanEditRowKey(A, "task-1", sha(2)))).toBeUndefined();
  });

  it("learning that is Off or only collecting reads nothing from the host and queues nothing; the install's switch off does the same", async () => {
    for (const mode of ["Off", "Collect"] as const) {
      const w = setup({ mode });
      expect(await w.produce(w.push()), mode).toBe("off");
      expect(w.asked, mode).toEqual([]);
      expect(w.identityReads(), mode).toBe(0);
      expect(w.sent, mode).toEqual([]);
    }
    const off = setup({ enabled: false });
    expect(await off.produce(off.push())).toBe("off");
    expect(off.asked).toEqual([]);
    expect(off.sent).toEqual([]);
    // With learning On the same push does queue.
    const on = setup({ mode: "On" });
    expect(await on.produce(on.push())).toBe("queued");
  });

  it("an install that can place no author as a member (its identity point links no accounts) reads nothing and queues nothing, so no host request is spent for a job that could only end skipped", async () => {
    const w = setup({ canPlace: false });
    expect(await w.produce(w.push())).toBe("no_identity");
    expect(w.asked).toEqual([]);
    expect(w.identityReads()).toBe(0);
    expect(w.sent).toEqual([]);
    expect(await w.store.get(humanEditRowKey(A, "task-1", sha(2)))).toBeUndefined();
  });

  it("a head that is the base, or not a commit id, is not read", async () => {
    const w = setup();
    expect(await w.produce(w.push(BASE))).toBe("unread");
    expect(await w.produce(w.push("not-a-sha"))).toBe("unread");
    expect(await w.produce(w.push(sha(2), { base: "not-a-sha" }))).toBe("unread");
    expect(w.asked).toEqual([]);
  });
});

describe("faults", () => {
  it("a queue that does not take the message gives the claim back, so the next pass queues it", async () => {
    const fails = { count: 1 };
    const w = setup({ queueFails: fails });
    expect(await w.produce(w.push())).toBe("not_queued");
    expect(w.sent).toEqual([]);
    expect(await w.store.get(humanEditRowKey(A, "task-1", sha(2)))).toBeUndefined();
    expect(w.logs).toContain("human_edit_not_queued");
    expect(await w.produce(w.push())).toBe("queued");
    expect(w.sent).toHaveLength(1);
  });
  it("a host that cannot answer throws and leaves no row (the next pass reads again); a repository the host cannot name queues nothing yet", async () => {
    const w = setup({ table: {} });
    await expect(w.produce(w.push())).rejects.toThrow();
    expect(await w.store.get(humanEditRowKey(A, "task-1", sha(2)))).toBeUndefined();
    const unnamed = setup({ identity: false });
    expect(await unnamed.produce(unnamed.push())).toBe("unread");
    expect(unnamed.sent).toEqual([]);
    expect(await unnamed.store.get(humanEditRowKey(A, "task-1", sha(2)))).toBeUndefined();
  });
  it("the request id stays within the message's 200 characters: a task id too long for it is hashed, the same task and head giving the same id", () => {
    const long = "t".repeat(190);
    expect(humanEditRequestId(long, sha(2)).length).toBeLessThanOrEqual(200);
    expect(humanEditRequestId(long, sha(2))).toBe(humanEditRequestId(long, sha(2)));
    expect(humanEditRequestId(long, sha(2))).not.toBe(humanEditRequestId(long, sha(3)));
  });
});
