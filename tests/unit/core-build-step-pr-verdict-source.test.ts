// Lane L4-PRP: the "Rovara" Check's verdict source (`createPullRequestVerdictSource`) and its wiring into the merge tracking service. Driven over the host-neutral service world (the task flow's own store, the fake code host).
// Rules: the verdict is only ever about the code Rovara recorded and checked, for this company; the files come from the list the code host gave; a source that cannot say gives nothing and the Check is what it was; the verdict never
// changes the Check's conclusion; the Check says the description's words.
import { describe, expect, it } from "vitest";
import { type OrgId, type StoredDocument } from "@agentx/contracts";
import type { MergeTask } from "../../packages/broker/src/core/merge/index.js";
import { createPullRequestVerdictSource } from "../../packages/broker/src/core/build-step/pull-request-verdict.js";
import { VERIFIED_FILES_KEPT_MAX, verifiedFilesKey } from "../../packages/broker/src/core/build-step/changed-files.js";
import { workflowPullRequestBody } from "../../packages/broker/src/core/proof/workflow-pull-request-body.js";
import { workspaceKeys } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { createMergeTrackingService, createMilestoneService } from "../../packages/broker/src/services/index.js";
import { fixedCodeSettings, type SummaryCheckSource } from "../../packages/broker/src/core/merge/index.js";
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
});

describe("the service adds the verdict to the Check the host asked for", () => {
  const trackingOf = (w: Awaited<ReturnType<typeof world>>, summaryCheck: SummaryCheckSource | undefined) => createMergeTrackingService({
    flow: w.h.deps, registry: w.registry, companyId: ORG, milestones: createMilestoneService({ store: w.h.store, now: w.clock.ms === 0 ? () => 0 : () => w.clock.ms }), people: w.people,
    settings: fixedCodeSettings({ allowSelfApproval: true, mergeMethod: "squash", codeReviewers: [], revision: 1 }), now: () => w.clock.ms, ...(summaryCheck === undefined ? {} : { summaryCheck }),
  });
  const SOURCE: SummaryCheckSource = { enabled: () => true };
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
});
