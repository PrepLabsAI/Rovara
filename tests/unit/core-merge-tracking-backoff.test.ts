import { expect, it, vi } from "vitest";
import { HostRateLimitError, change, mergeTrackingKey, type CodeHost, type WorkflowSnapshot } from "@agentx/contracts";
import { host, ORG } from "../support/service-host.js";
import { TASK_ID } from "../support/merge-world.js";
import { recoveryRowKey } from "../../packages/broker/src/core/merge/store.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { coreTaskMarkKey } from "../../packages/broker/src/core-host/core-task-mark.js";
import { linkedChangeRequestStep } from "../../packages/broker/src/core/proof/revert/linked-change-requests.js";
import { HeadFactMemo } from "../../packages/broker/src/core/merge/head-fact-memo.js";
import { workspaceKeys } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { verifiedFilesKey } from "../../packages/broker/src/core/build-step/changed-files.js";
import { readHeadFacts } from "../../packages/broker/src/core/merge/change-tier-read.js";
import { tierFromDiff, type TierFile } from "../../packages/broker/src/core/decisions/change-tier.js";

async function world() {
  const w = await host();
  w.h.deps.codeHosts = w.registry;
  const codeHost = w.registry.get("code-host", "github") as CodeHost;
  return { ...w, codeHost };
}

/** D1-2: the merge sweep reads only tasks that carry the core's mark, so a task these cases copy from the world's own task carries a copy of its mark. */
async function markLikeWorldTask(w: Awaited<ReturnType<typeof world>>, copyId: string): Promise<void> {
  const mark = (await w.h.store.get(coreTaskMarkKey(TASK_ID)))!;
  await w.h.store.put({ item: { ...mark, ...coreTaskMarkKey(copyId), taskId: copyId } });
}

it("backs off allowance-exhausted verification to fifteen minutes without resetting quiet, while reconcile still reads", async () => {
  const w = await world();
  // A host with enough pages to spend every verification allowance, even on a frozen clock.
  let pages = 0;
  w.codeHost.fileAtRevision = async () => undefined;
  // The path probes below exceed even the single-row allowance.
  w.codeHost.changedFiles = async () => {
    pages++;
    return { files: Array.from({ length: 30 }, (_, n) => ({ path: `docs/f${pages}-${n}/intro.md`, status: "modified" as const, additions: 1, deletions: 1, patch: "-old\n+new" })), nextPage: 2 };
  };
  await w.h.store.update({ key: recoveryRowKey(TASK_ID), ops: [change.set("quiet", 4)] });
  const status = vi.spyOn(w.codeHost, "changeRequestStatus");
  for (const wait of [60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 660, 720, 780, 840, 900, 900]) {
    const at = w.clock.ms;
    await w.tracking.sweep();
    const row = (await w.h.store.get(recoveryRowKey(TASK_ID)))!;
    expect(row["nextAttemptAt"]).toBe(at + wait * 1000);
    expect(row["quiet"]).toBe(4);
    expect(row["attempts"]).toBeGreaterThan(0);
    w.clock.ms = row["nextAttemptAt"] as number;
  }
  expect(pages).toBeGreaterThan(0);
  expect(status).toHaveBeenCalled();
  expect(w.tracking.pausedUntil()).toBeUndefined();
});

it("reserves reads for reconcile and another due task when the first verifier spends its share", async () => {
  const w = await world();
  const other = "22222222-2222-4222-8222-222222222222";
  const task = (await w.h.store.get(taskKey(TASK_ID)))!;
  const model = w.world.prs[0]!.model;
  const head = model.commit("other-task", { "src/other.ts": "export const other = 1;\n" });
  const { cr } = model.reconcile({ sourceBranch: "other-task", targetBranch: "main", title: "Other task" });
  const workflow = task["workflow"] as unknown as WorkflowSnapshot;
  const pr = { ...workflow.pullRequests![0]!, number: Number(cr.id), headSha: head, url: model.crUrl(cr.id) };
  await w.h.store.put({ item: { ...task, ...taskKey(other), taskId: other, workflow: JSON.parse(JSON.stringify({ ...workflow, taskId: other, pullRequests: [pr] })) as never } });
  await w.h.store.transact([linkedChangeRequestStep({ hostKind: "github", repositoryAddress: "https://github.com/acme/app", changeRequestId: cr.id, repositoryId: "app", number: Number(cr.id), url: pr.url,
    taskId: other, workspaceId: task["workspaceId"] as string, candidateDigest: pr.candidateDigest, createdAt: new Date(w.clock.ms).toISOString() })!]);
  await markLikeWorldTask(w, other);
  await w.h.store.put({ item: { ...recoveryRowKey(other), kind: "tracking", taskId: other, nextAttemptAt: 0 } });
  let reads = 0;
  const fileAtRevision = w.codeHost.fileAtRevision.bind(w.codeHost);
  const pathKind = w.codeHost.pathKind!.bind(w.codeHost);
  w.codeHost.fileAtRevision = async (...args) => { reads++; return fileAtRevision(...args); };
  w.codeHost.pathKind = async (...args) => { reads++; return pathKind(...args); };
  w.codeHost.changedFiles = async () => {
    reads++;
    return { files: Array.from({ length: 30 }, (_, n) => ({ path: `docs/d${n}/intro.md`, status: "modified" as const, additions: 1, deletions: 0, patch: "+text" })), nextPage: 2 };
  };
  const readsAtReconcile: number[] = [];
  const statusRead = w.codeHost.changeRequestStatus.bind(w.codeHost);
  const status = vi.spyOn(w.codeHost, "changeRequestStatus").mockImplementation(async (...args) => {
    readsAtReconcile.push(reads);
    return statusRead(...args);
  });
  expect(await w.tracking.sweep()).toEqual({ attempted: 2 });
  expect(status).toHaveBeenCalledTimes(2);
  // Each verifier gets 64 requests, including its initial head check. Its own reconcile retains the rest.
  expect(readsAtReconcile[0]).toBeLessThanOrEqual(63);
  expect(readsAtReconcile[1]! - readsAtReconcile[0]!).toBeLessThanOrEqual(63);
  expect(await w.h.store.get(mergeTrackingKey(other, "app", Number(cr.id)))).toMatchObject({ headSha: head });
  expect((await w.h.store.get(recoveryRowKey(other)))?.["attempts"]).toBe(1);
});

it("keeps normal changed passes at sixty seconds and quiet passes doubling to five minutes", async () => {
  const w = await world();
  await w.h.store.update({ key: recoveryRowKey(TASK_ID), ops: [change.set("quiet", 4)] });
  const at = w.clock.ms;
  await w.tracking.sweep();
  expect(await w.h.store.get(recoveryRowKey(TASK_ID))).toMatchObject({ quiet: 0, attempts: 0, nextAttemptAt: at + 60_000 });
  for (const wait of [120_000, 240_000, 300_000, 300_000]) {
    w.clock.ms = (await w.h.store.get(recoveryRowKey(TASK_ID)))!["nextAttemptAt"] as number;
    const before = w.clock.ms;
    await w.tracking.sweep();
    expect((await w.h.store.get(recoveryRowKey(TASK_ID)))?.["nextAttemptAt"]).toBe(before + wait);
  }
});

it("still pauses the whole service on a host rate limit during verification", async () => {
  const w = await world();
  const until = w.clock.ms + 10 * 60_000;
  const read = vi.spyOn(w.codeHost, "getChangeRequest").mockRejectedValue(new HostRateLimitError(until));
  expect(await w.tracking.sweep()).toEqual({ attempted: 1 });
  expect(w.tracking.pausedUntil()).toBe(until);
  read.mockClear();
  expect(await w.tracking.sweep()).toEqual({ attempted: 0 });
  expect(read).not.toHaveBeenCalled();
});

const files: TierFile[] = [{ repository: "app", path: "docs/intro.md", status: "modified", additions: 1, deletions: 1, patch: "-old\n+new" }];

it("memoises immutable head facts, charges only new probes, and isolates repository, company and head", async () => {
  const w = await world();
  w.codeHost.fileAtRevision = async () => undefined;
  w.codeHost.pathKind = async () => "none";
  const target = { host: w.codeHost, repositoryId: "app", repositoryUrl: "https://github.com/acme/app", number: 1, headSha: w.world.prs[0]!.head };
  let requests = 0;
  const before = () => { requests++; };
  const first = await readHeadFacts([target], files, { orgId: ORG }, before);
  expect(requests).toBeGreaterThan(20);
  requests = 0;
  expect(await readHeadFacts([target], files, { orgId: ORG }, before)).toEqual(first);
  expect(requests).toBe(0);
  for (const [next, scope] of [
    [{ ...target, headSha: "f".repeat(40) }, { orgId: ORG }],
    [{ ...target, repositoryUrl: "https://github.com/acme/other" }, { orgId: ORG }],
    [target, { orgId: "org_bbbbbbbbbbbbbbbbbbbb" }],
  ] as const) {
    requests = 0;
    await readHeadFacts([next], files, scope, before);
    expect(requests).toBeGreaterThan(20);
  }
});

it("retains completed immutable probes after allowance exhaustion so a large head can finish next pass", async () => {
  const w = await world();
  w.codeHost.fileAtRevision = async () => undefined;
  w.codeHost.pathKind = async () => "none";
  const target = { host: w.codeHost, repositoryId: "app", repositoryUrl: "https://github.com/acme/app", number: 1, headSha: w.world.prs[0]!.head };
  let cold = 0;
  await readHeadFacts([{ ...target, headSha: "f".repeat(40) }], files, { orgId: ORG }, () => { cold++; });
  let used = 0;
  await expect(readHeadFacts([target], files, { orgId: ORG }, () => { if (++used > 30) throw new Error("allowance spent"); })).rejects.toThrow("allowance spent");
  let resumed = 0;
  await readHeadFacts([target], files, { orgId: ORG }, () => { resumed++; });
  expect(resumed).toBe(cold - 30);
});

it("makes only the two head checks on a second sweep over the same verified head", async () => {
  const w = await world();
  await w.tracking.sweep();
  const listed = vi.spyOn(w.codeHost, "changedFiles");
  const filesRead = vi.spyOn(w.codeHost, "fileAtRevision");
  const kindRead = vi.spyOn(w.codeHost, "pathKind");
  const verificationHead = vi.spyOn(w.codeHost, "getChangeRequest");
  const status = vi.spyOn(w.codeHost, "changeRequestStatus");
  const observation = vi.spyOn(w.codeHost, "mergeObservation");
  w.clock.ms += 300_000;
  expect(await w.tracking.sweep()).toEqual({ attempted: 1 });
  expect(status).toHaveBeenCalledTimes(1);
  expect(observation).toHaveBeenCalledTimes(1);
  expect(listed).not.toHaveBeenCalled();
  expect(filesRead).not.toHaveBeenCalled();
  expect(kindRead).not.toHaveBeenCalled();
  expect(verificationHead).not.toHaveBeenCalled();
});

it("preserves a global rate limit from reconcile after unavailable verification", async () => {
  const w = await world();
  const until = w.clock.ms + 600_000;
  w.codeHost.changedFiles = async () => { throw new Error("host unavailable"); };
  vi.spyOn(w.codeHost, "changeRequestStatus").mockRejectedValue(new HostRateLimitError(until));
  await w.tracking.sweep();
  expect(w.tracking.pausedUntil()).toBe(until);
  expect(await w.h.store.get(recoveryRowKey(TASK_ID))).toMatchObject({ attempts: 1, nextAttemptAt: until });
});


it("keeps document decisions and imports without retaining raw file bodies", async () => {
  const w = await world();
  const body = "# Install\n\nNew line.\n# Overview\nMore prose.\n" + "Unchanged prose.\n".repeat(5000);
  w.codeHost.fileAtRevision = async (_repo, path) => path === "docs/intro.md" ? body : path === "AGENTS.md" ? "@docs/rules.md\n" + "Instructions.\n".repeat(5000) : undefined;
  w.codeHost.pathKind = async () => "none";
  const target = { host: w.codeHost, repositoryId: "app", repositoryUrl: "https://github.com/acme/app", number: 1, headSha: "a".repeat(40) };
  const diff = [{ ...files[0]!, patch: "@@ -3 +3 @@\n-Old line.\n+New line.", entry: { head: "file" as const, base: "file" as const } }];
  const writes = vi.spyOn(HeadFactMemo.prototype, "set");
  const head = await readHeadFacts([target], diff, { orgId: ORG });
  const stored = writes.mock.calls.map(([, value]) => value as unknown);
  writes.mockRestore();
  expect(stored.length).toBeGreaterThan(0);
  expect(JSON.stringify(stored).length).toBeLessThan(2000);
  expect(head.text?.size ?? 0).toBe(0);
  expect(head.instructionImports).toContain("app\u0000docs/rules.md");
  expect(tierFromDiff({ files: diff, complete: true }, { at: "2026-11-22T00:00:00Z", head }).kinds).toContain("install_link");
  // Same immutable head, different base/patch: the install decision must be recomputed.
  const next = [{ ...diff[0]!, patch: "@@ -5 +5 @@\n-Old prose.\n+More prose." }];
  const again = await readHeadFacts([target], next, { orgId: ORG });
  expect(tierFromDiff({ files: next, complete: true }, { at: "2026-11-22T00:00:00Z", head: again }).kinds).toEqual(["docs"]);
});

it("retries failed immutable reads instead of memoising an unknown fact", async () => {
  const w = await world();
  let failed = true;
  w.codeHost.fileAtRevision = async (_repo, path) => {
    if (path === "AGENTS.md") { if (failed) throw new Error("temporary host failure"); return "@docs/intro.md"; }
    return undefined;
  };
  w.codeHost.pathKind = async () => "none";
  const target = { host: w.codeHost, repositoryId: "app", repositoryUrl: "https://github.com/acme/app", number: 1, headSha: "a".repeat(40) };
  expect((await readHeadFacts([target], files, { orgId: ORG })).importsKnown).toBe(false);
  failed = false;
  const next = await readHeadFacts([target], files, { orgId: ORG });
  expect(next.importsKnown).toBe(true);
  expect(next.instructionImports).toContain("app\u0000docs/intro.md");
});

it("bounds reconcile reads on ten due rows so the last row still gets its share", async () => {
  const w = await world();
  // Verification is unavailable before spending more than its initial head request.
  w.codeHost.getChangeRequest = async () => { throw new Error("temporarily unavailable"); };
  const task = (await w.h.store.get(taskKey(TASK_ID)))!;
  const workflow = task["workflow"] as unknown as WorkflowSnapshot;
  for (let n = 2; n <= 10; n++) {
    const id = `${String(n).padStart(8, "0")}-2222-4222-8222-222222222222`;
    const model = w.world.prs[0]!.model;
    const branch = `due-${n}`;
    const head = model.commit(branch, { "src/other.ts": "export const other = 1;" });
    const { cr } = model.reconcile({ sourceBranch: branch, targetBranch: "main", title: branch });
    const pr = { ...workflow.pullRequests![0]!, number: Number(cr.id), headSha: head, url: model.crUrl(cr.id) };
    await w.h.store.put({ item: { ...task, ...taskKey(id), taskId: id, workflow: JSON.parse(JSON.stringify({ ...workflow, taskId: id, pullRequests: [pr] })) as never } });
    await w.h.store.transact([linkedChangeRequestStep({ hostKind: "github", repositoryAddress: "https://github.com/acme/app", changeRequestId: cr.id, repositoryId: "app", number: Number(cr.id), url: pr.url,
      taskId: id, workspaceId: task["workspaceId"] as string, candidateDigest: pr.candidateDigest, createdAt: new Date(w.clock.ms).toISOString() })!]);
    await markLikeWorldTask(w, id);
    await w.h.store.put({ item: { ...recoveryRowKey(id), kind: "tracking", taskId: id, nextAttemptAt: 0 } });
  }
  const reads: number[] = [];
  w.codeHost.changeRequestStatus = async (_ref, _scope, budget) => {
    const index = reads.length;
    reads.push(0);
    for (let n = 0; n < 40; n++) { budget?.beforeRequest(); reads[index]!++; }
    throw new Error("unreachable: task allowance must stop the host");
  };
  expect(await w.tracking.sweep()).toEqual({ attempted: 10 });
  expect(reads).toHaveLength(10);
  expect(reads).toEqual(Array(10).fill(24)); // 25 per row minus verification's one request.
});


it("caps retained fact bytes at 16 MiB and evicts least recently used entries", () => {
  const memo = new HeadFactMemo<readonly string[]>();
  const facts = ["docs/" + "x".repeat(65_536) + ".md"];
  for (let n = 0; n < 60; n++) memo.set(String(n), facts);
  expect(memo.get("0")?.value).toEqual(facts); // Refresh oldest before overflowing.
  for (let n = 60; n < 70; n++) {
    memo.set(String(n), facts);
    expect(memo.bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  }
  expect(memo.get("0")?.value).toEqual(facts);
  expect(memo.get("1")).toBeUndefined();
  expect(memo.get("69")?.value).toEqual(facts);
  const before = memo.bytes;
  memo.set("69", facts);
  expect(memo.bytes).toBe(before);
  memo.set("oversized", ["x".repeat(5 * 1024 * 1024)]);
  expect(memo.get("oversized")).toBeUndefined();
  expect(memo.bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
});

it("reuses only parsed existence facts when a host has no path-kind port", async () => {
  const w = await world();
  // The fake inherits the optional method: shadow it to exercise the fallback.
  Object.defineProperty(w.codeHost, "pathKind", { value: undefined });
  w.codeHost.fileAtRevision = async (_repo, path) => path === ".cursor" ? "x".repeat(2_000_000) : undefined;
  const writes = vi.spyOn(HeadFactMemo.prototype, "set");
  const target = { host: w.codeHost, repositoryId: "app", repositoryUrl: "https://github.com/acme/app", number: 1, headSha: "a".repeat(40) };
  const head = await readHeadFacts([target], files, { orgId: ORG });
  const stored = writes.mock.calls.map(([, value]) => value as unknown);
  writes.mockRestore();
  expect(head.importsKnown).toBe(false);
  expect(stored).toContain(true);
  expect(JSON.stringify(stored).length).toBeLessThan(2000);
  let reads = 0;
  await readHeadFacts([target], files, { orgId: ORG }, () => { reads++; });
  expect(reads).toBe(0);
});


it("reuses the memo through a second fresh verification after the verified marker is lost", async () => {
  const w = await world();
  await w.tracking.sweep();
  const task = (await w.h.store.get(taskKey(TASK_ID)))!;
  const workflow = task["workflow"] as unknown as WorkflowSnapshot;
  const location = await workspaceKeys(w.h.deps, task["workspaceId"] as string);
  await w.h.store.delete({ key: verifiedFilesKey(location.workspaceKey, workflow.candidate!.digest) });
  const listed = vi.spyOn(w.codeHost, "changedFiles");
  const body = vi.spyOn(w.codeHost, "fileAtRevision");
  const kind = vi.spyOn(w.codeHost, "pathKind");
  const heads = vi.spyOn(w.codeHost, "getChangeRequest");
  w.clock.ms += 300_000;
  expect(await w.tracking.sweep()).toEqual({ attempted: 1 });
  expect(listed).toHaveBeenCalledTimes(1); // PR diffs stay fresh even on an unchanged head.
  expect(heads).toHaveBeenCalledTimes(2);
  expect(body).not.toHaveBeenCalled();
  expect(kind).not.toHaveBeenCalled();
  expect(await w.h.store.get(verifiedFilesKey(location.workspaceKey, workflow.candidate!.digest))).toBeDefined();
});
