// Lane L4-PRP: the "Rovara" Check's verdict source (`createPullRequestVerdictSource`) and its wiring into the merge tracking service. Driven over the host-neutral service world (the task flow's own store, the fake code host).
// Rules: the verdict is only ever about the code Rovara recorded and checked, for this company; the files come from the list the code host gave; a source that cannot say gives nothing and the Check is what it was; the verdict never
// changes the Check's conclusion; the Check says the description's words.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, type OrgId, type StoredDocument } from "@agentx/contracts";
import type { MergeTask } from "../../packages/broker/src/core/merge/index.js";
import { createPullRequestVerdictSource } from "../../packages/broker/src/core/build-step/pull-request-verdict.js";
import { VERIFIED_FILES_KEPT_MAX, verifiedFilesKey } from "../../packages/broker/src/core/build-step/changed-files.js";
import { workflowPullRequestBody } from "../../packages/broker/src/core/proof/workflow-pull-request-body.js";
import { workspaceKeys } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { createMergeTrackingService, createMilestoneService } from "../../packages/broker/src/services/index.js";
import { fixedCodeSettings, summaryCheckKey, type SummaryCheckSource } from "../../packages/broker/src/core/merge/index.js";
import { ORG, host } from "../support/service-host.js";
import { TASK_ID } from "../support/merge-world.js";

type TaskDoc = { workflow: { pullRequests: Array<{ candidateDigest: string; state: string }>; definitionVersion: string }; closedAt?: string };
const OTHER = "org_11111111111111111111" as OrgId;

async function world() {
  const w = await host();
  const pr = w.world.prs[0]!;
  const task = (await readTask(w.h.deps, TASK_ID))!;
  const input = { task: { ...task, orgId: ORG } as unknown as MergeTask, repositoryId: pr.repositoryId, number: pr.number, headSha: pr.head };
  const keepFiles = async (files: Array<{ repository: string; path: string; added: number; removed: number }>, complete = true) => {
    const location = await workspaceKeys(w.h.deps, task.workspaceId);
    await w.world.store.put({ item: { ...verifiedFilesKey(location.workspaceKey, task.workflow!.candidate!.digest), entityType: "VERIFIED_FILES", candidateDigest: task.workflow!.candidate!.digest, complete, verifiedAt: "2026-11-09T10:00:00.000Z", files } });
  };
  // The task record as stored, changed in place (the store takes no array index in an update path).
  const patchTask = async (patch: (record: TaskDoc) => void) => {
    const stored = JSON.parse(JSON.stringify((await w.world.store.get(taskKey(TASK_ID)))!)) as unknown as TaskDoc;
    patch(stored);
    await w.world.store.put({ item: stored as unknown as StoredDocument });
  };
  return { ...w, pr, task, input, source: createPullRequestVerdictSource(w.h.deps), keepFiles, patchTask };
}

describe("the verdict source", () => {
  it("says a verdict for the recorded, checked code, with the files the code host gave", async () => {
    const w = await world();
    await w.keepFiles([{ repository: "app", path: "src/a.ts", added: 3, removed: 1 }]);
    const verdict = await w.source(w.input);
    expect(verdict).toBeDefined();
    expect(verdict!.heading).toContain("risk");
    expect(verdict!.body.some((line) => line.startsWith("**Changed** "))).toBe(true);
  });
  // Mutant S1: the source ignores the head (a stale or someone else's head gets the verdict of the recorded one).
  it("a head that is not the recorded one has no verdict", async () => {
    const w = await world();
    expect(await w.source({ ...w.input, headSha: "a".repeat(40) })).toBeUndefined();
  });
  // Mutant S2: the pull request's candidate is not compared with the workflow's.
  it("a pull request that holds another candidate has no verdict", async () => {
    const w = await world();
    await w.patchTask((record) => { record.workflow.pullRequests[0]!.candidateDigest = "9".repeat(64); });
    expect(await w.source(w.input)).toBeUndefined();
  });
  it("a pull request the workflow does not know, a closed or merged one, and a closed task have no verdict", async () => {
    const w = await world();
    expect(await w.source({ ...w.input, number: w.input.number + 40 })).toBeUndefined();
    expect(await w.source({ ...w.input, repositoryId: "other-repo" })).toBeUndefined();
    await w.patchTask((record) => { record.workflow.pullRequests[0]!.state = "MERGED"; });
    expect(await w.source(w.input)).toBeUndefined();
    await w.patchTask((record) => { record.workflow.pullRequests[0]!.state = "OPEN"; record.closedAt = "2026-11-09T11:00:00.000Z"; });
    expect(await w.source(w.input)).toBeUndefined();
  });
  it("a version 1 workflow has no verdict", async () => {
    const w = await world();
    await w.patchTask((record) => { record.workflow.definitionVersion = "1.0.0"; });
    expect(await w.source(w.input)).toBeUndefined();
  });
  // Mutant S3: the company is not compared (two-company isolation), either on the task of the Check or on the task read.
  it("another company's flow reads nothing of this company's task, and a Check for another company's task is not answered", async () => {
    const w = await world();
    await w.keepFiles([{ repository: "app", path: "src/a.ts", added: 3, removed: 1 }]);
    const other = createPullRequestVerdictSource({ ...w.h.deps, companyId: OTHER });
    expect(await other(w.input)).toBeUndefined();
    expect(await other({ ...w.input, task: { ...w.input.task, orgId: OTHER } })).toBeUndefined();
    // Positive control: this company's source does answer the same input.
    expect(await w.source(w.input)).toBeDefined();
    expect(ORG).toBe(IMPLICIT_COMPANY_ID);
  });
  // Mutants S3a / S3b: each company guard alone must stop the read, so neither is only a second line of defence that the other hides.
  const reads = <T extends object>(store: T, log: string[]): T => new Proxy(store, { get: (target, key) => (key === "get" ? async (k: { pk: string; sk: string }) => { log.push(`${k.pk}|${k.sk}`); return ((target as unknown as { get: (x: unknown) => Promise<unknown> }).get).call(target, k); } : (Reflect.get(target, key) as unknown)) });
  it("a Check for another company's task reads nothing at all (the input's company guard)", async () => {
    const w = await world();
    const log: string[] = [];
    const source = createPullRequestVerdictSource({ ...w.h.deps, store: reads(w.h.deps.store, log) });
    expect(await source({ ...w.input, task: { ...w.input.task, orgId: OTHER } })).toBeUndefined();
    expect(log).toEqual([]);
    // Positive control: the same proxied store, for this company's own Check, is read, and answers.
    expect(await source(w.input)).toBeDefined();
    expect(log.length).toBeGreaterThan(1);
  });
  it("another company's flow reads the task row and stops there (the task record's company guard)", async () => {
    const w = await world();
    const log: string[] = [];
    const source = createPullRequestVerdictSource({ ...w.h.deps, companyId: OTHER, store: reads(w.h.deps.store, log) });
    expect(await source({ ...w.input, task: { ...w.input.task, orgId: OTHER } })).toBeUndefined();
    expect(log).toHaveLength(1);
    expect(log[0]).toContain(TASK_ID);
  });
  // The worker's own list is never an input: the source does not even name the reader of it.
  it("the source never reads the worker's reported file list", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(new URL("../../packages/broker/src/core/build-step/pull-request-verdict.ts", import.meta.url), "utf8");
    expect(text).not.toMatch(/reportedChangedFiles|workspace\.diff|WORKSPACE_DIFF_ARTIFACT/u);
  });
  it("a kept list of files that was cut at the keep's limit gives no verdict (the description was made from the whole list)", async () => {
    const w = await world();
    await w.keepFiles(Array.from({ length: VERIFIED_FILES_KEPT_MAX }, (_, index) => ({ repository: "app", path: `src/f${index}.ts`, added: 1, removed: 0 })));
    expect(await w.source(w.input)).toBeUndefined();
    await w.keepFiles(Array.from({ length: VERIFIED_FILES_KEPT_MAX - 1 }, (_, index) => ({ repository: "app", path: `src/f${index}.ts`, added: 1, removed: 0 })));
    expect(await w.source(w.input)).toBeDefined();
  });
  it("a store that fails gives no verdict instead of throwing", async () => {
    const w = await world();
    const broken = createPullRequestVerdictSource({ ...w.h.deps, store: new Proxy(w.h.deps.store, { get: (target, key) => (key === "get" ? async () => { throw new Error("down"); } : (Reflect.get(target, key) as unknown)) }) });
    expect(await broken(w.input)).toBeUndefined();
  });
});

describe("what a published pull request looks like, and what the description's inputs add", () => {
  // Mutant U1: only OPEN is taken (a published pull request is recorded UNKNOWN until a fix push, so the Check would never get a verdict).
  it("a pull request recorded UNKNOWN (as a published one is) has a verdict", async () => {
    const w = await world();
    await w.patchTask((record) => { record.workflow.pullRequests[0]!.state = "UNKNOWN"; });
    expect(await w.source(w.input)).toBeDefined();
  });
  // Mutant U2: the description inputs (second review, merge order) are not passed to the verdict.
  it("a blocking second review and the merge order reach the Check's list, from the same seams the description reads", async () => {
    const w = await world();
    await w.keepFiles([{ repository: "app", path: "src/a.ts", added: 3, removed: 1 }]);
    const deps = w.h.deps as { secondReview?: unknown; mergeOrderLines?: unknown };
    deps.secondReview = { prLines: () => ["Second review (openai/model-b): 1 blocking finding", "- The retry never stops (src/a.ts:3)"], prStatus: () => ({ state: "blocking", count: 1, model: "openai/model-b", findings: [{ text: "The retry never stops", file: "src/a.ts", line: 3 }] }) };
    deps.mergeOrderLines = async () => ["Merge the app pull request first."];
    const verdict = (await createPullRequestVerdictSource(w.h.deps)(w.input))!;
    const text = verdict.body.join("\n");
    expect(text).toContain("The retry never stops");
    expect(text).toContain("Merge the app pull request first.");
    const body = workflowPullRequestBody({ ...w.task, title: "Add retry" }, w.task.workflow!, undefined, undefined, {
      changedFiles: { files: [{ repository: "app", path: "src/a.ts", added: 3, removed: 1 }], complete: true }, lessonsUsed: { count: 0, taskUrl: "", entries: [], none: true },
      secondReviewLines: ["Second review (openai/model-b): 1 blocking finding", "- The retry never stops (src/a.ts:3)"], secondReview: { state: "blocking", count: 1, model: "openai/model-b", findings: [{ text: "The retry never stops", file: "src/a.ts", line: 3 }] }, mergeOrderLines: ["Merge the app pull request first."],
    });
    const above = body.slice(0, body.indexOf("<details>")).split("\n");
    expect(above).toContain(`## ${verdict.heading}`);
    for (const line of verdict.body.filter((entry) => entry !== "")) expect(above, line).toContain(line);
  });
  // Mutant U3: the worker's own list (workspace.diff) is believed by the source. It reads only the code host's kept list.
  it("a list the worker reported is never read: without the host's kept list the risk is high even when a worker diff exists", async () => {
    const w = await world();
    const deps = w.h.deps as { artifacts?: unknown };
    let asked = 0;
    deps.artifacts = { get: async () => { asked += 1; return new TextEncoder().encode("diff --git a/docs/a.md b/docs/a.md\n--- a/docs/a.md\n+++ b/docs/a.md\n@@ -1 +1 @@\n-a\n+b\n"); } };
    const verdict = (await createPullRequestVerdictSource(w.h.deps)(w.input))!;
    expect(verdict.heading).toMatch(/high/iu);
    expect(asked).toBe(0);
  });
});

describe("bad news is in the Check's words, not only in a heading", () => {
  // Mutant S4: the files not read are not said (the risk shown as a clean low one).
  it("with no list of files from the code host, the risk is treated as high and the list says the files were not read", async () => {
    const w = await world();
    const verdict = (await w.source(w.input))!;
    expect(verdict.heading).toMatch(/high/iu);
    expect(verdict.body).toContain("### Check these before you approve");
    expect(verdict.body.join("\n")).toMatch(/files|code host/iu);
  });
  it("the Check says the same heading and lines as the description built from the same inputs", async () => {
    const w = await world();
    await w.keepFiles([{ repository: "app", path: "src/a.ts", added: 3, removed: 1 }]);
    const verdict = (await w.source(w.input))!;
    const task = w.task;
    const body = workflowPullRequestBody({ ...task, title: "Add retry" }, task.workflow!, undefined, undefined, { changedFiles: { files: [{ repository: "app", path: "src/a.ts", added: 3, removed: 1 }], complete: true }, lessonsUsed: { count: 0, taskUrl: "", entries: [], none: true } });
    const above = body.slice(0, body.indexOf("<details>")).split("\n");
    expect(above).toContain(`## ${verdict.heading}`);
    for (const line of verdict.body.filter((entry) => entry !== "")) expect(above, line).toContain(line);
  });
});

describe("the service adds the verdict to the Check the host asked for", () => {
  const trackingOf = (w: Awaited<ReturnType<typeof world>>, summaryCheck: SummaryCheckSource | undefined) => createMergeTrackingService({
    flow: w.h.deps, registry: w.registry, companyId: ORG, milestones: createMilestoneService({ store: w.h.store, now: w.clock.ms === 0 ? () => 0 : () => w.clock.ms }), people: w.people,
    settings: fixedCodeSettings({ allowSelfApproval: true, mergeMethod: "squash", codeReviewers: [], revision: 1 }), now: () => w.clock.ms, ...(summaryCheck === undefined ? {} : { summaryCheck }),
  });
  const SOURCE: SummaryCheckSource = { enabled: () => true };

  it("without a summaryCheck option nothing is written (as before)", async () => {
    const w = await world();
    await trackingOf(w, undefined).sweep();
    expect(w.pr.model.summaryChecks).toEqual([]);
    expect(await w.world.store.get(summaryCheckKey(ORG, TASK_ID, w.pr.repositoryId, w.pr.number))).toBeUndefined();
  });
  // Mutant W1: the service does not give the Check a verdict source.
  it("with one, the Check's text carries the description's verdict", async () => {
    const w = await world();
    await w.keepFiles([{ repository: "app", path: "src/a.ts", added: 3, removed: 1 }]);
    const tracking = trackingOf(w, SOURCE);
    expect(typeof tracking.deps.summaryCheck?.verdict).toBe("function");
    const expected = (await w.source(w.input))!;
    await tracking.sweep();
    const written = w.pr.model.summaryChecks.at(-1)!;
    expect(written.payload.text).toContain(`**${expected.heading}**`);
    for (const line of expected.body.filter((entry) => entry !== "")) expect(written.payload.text).toContain(line);
  });
  it("a verdict the host gives itself is kept, not replaced", async () => {
    const w = await world();
    const own = { resultKind: "checks_passed", heading: "The host's own heading", body: ["**Changed** host words"] };
    const tracking = trackingOf(w, { ...SOURCE, verdict: async () => own });
    expect(tracking.deps.summaryCheck?.verdict === undefined).toBe(false);
    await tracking.sweep();
    expect(w.pr.model.summaryChecks.at(-1)!.payload.text).toContain("The host's own heading");
  });
  // Mutant W2: the verdict changes the conclusion. The same pass with and without it gives the same status and conclusion.
  it("the verdict never changes the Check's conclusion", async () => {
    const withVerdict = await world();
    await withVerdict.keepFiles([{ repository: "app", path: "src/a.ts", added: 3, removed: 1 }]);
    await trackingOf(withVerdict, SOURCE).sweep();
    const without = await world();
    await trackingOf(without, { ...SOURCE, verdict: async () => undefined }).sweep();
    const a = withVerdict.pr.model.summaryChecks.at(-1)!.payload;
    const b = without.pr.model.summaryChecks.at(-1)!.payload;
    expect({ status: a.status, conclusion: a.conclusion }).toEqual({ status: b.status, conclusion: b.conclusion });
  });
});
