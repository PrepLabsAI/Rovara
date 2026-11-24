// F4-0 (plan rev 3, 2.1): the per-hook failure table, pinned as it behaves TODAY through the composed flow. A second review (mode `on`) that throws in exactly one member never lets a change through
// unreviewed: `prepare` aborts the step; `opinionOf` blocks the workflow; `mergeWait` refuses the merge; `prLines`/`prStatus` propagate; `operationEnded` members catch inside themselves, and the engine
// adds NO catch of its own at close.ts:69 or in close recovery. Where a member is a stub it is the real service with ONE member replaced by a throw.
import { describe, expect, it, vi } from "vitest";
import { createPullRequestVerdictSource } from "../../packages/broker/src/core/build-step/pull-request-verdict.js";
import { VERIFIED_FILES_KEPT_MAX, descriptionInputsOf, verifiedFilesKey } from "../../packages/broker/src/core/build-step/changed-files.js";
import { prepareMerge, pressMerge, mergeViewOf, readMergeTracking } from "../../packages/broker/src/core/merge/index.js";
import { workspaceKeys } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import type { MergeTask } from "../../packages/broker/src/core/merge/index.js";
import { startReview } from "../../packages/broker/src/core/build-step/start.js";
import { closeTask } from "../../packages/broker/src/core/task-flow/close.js";
import { readTask, workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { readOperation } from "../../packages/broker/src/core/task-flow/results.js";
import { mergeWorld, ORG as MERGE_ORG, TASK_ID as MERGE_TASK } from "../support/merge-world.js";
import { publicationWorld } from "../support/f4-pins-publication.js";
import { host, ORG } from "../support/service-host.js";
import { COMPANY, TASK_ID, WORKSPACE_ID, closeWithRunHold, endReview, failAcceptingTheStep, reviewWorld, startReviewStep } from "../support/f4-pins-world.js";

const boom = (name: string) => Object.assign(new Error(`${name} detail that must stay out of logs`), { name });

describe("operationEnded: each member catches inside itself; the engine catches nothing at close.ts:69 or in close recovery", () => {
  it("second review's own member catches a failing release (logged by name only): a result and a close are not failed, and the hold goes back on a repeat", async () => {
    for (const exit of ["result", "close"] as const) {
      const w = await reviewWorld();
      const { operation } = await startReviewStep(w.h);
      const id = operation!.secondReviewPlan!.reservationId!;
      const real = w.review.deps.admission;
      w.review.deps.admission = { ...real, release: async () => { throw boom("ReleaseDown"); } };
      if (exit === "result") await w.h.flow.recordResult({ workspaceId: WORKSPACE_ID, operationId: operation!.id, fence: operation!.fence, status: "FAILED", error: "stopped" });
      else await closeTask(w.h.deps, w.h.owner, TASK_ID);
      // The hold is still open (its release failed) and the failure is in the log by error name only.
      expect(await w.money.stateOf(id), exit).toBe("open");
      expect(w.logs).toContainEqual({ event: "second_review.release_failed", errorName: "ReleaseDown" });
      expect(JSON.stringify(w.logs)).not.toContain("must stay out of logs");
      // At least once, idempotent: the same member, called again with the admission back, gives it back.
      w.review.deps.admission = real;
      await w.review.operationEnded(operation!);
      expect(await w.money.stateOf(id)).toBe("released");
    }
  });

  it("a member that throws is NOT caught by the engine at the result (results.ts:98) or at the close (close.ts:69): the call fails after the commit, and a repeat finishes", async () => {
    const result = await reviewWorld();
    const ran = await startReviewStep(result.h);
    result.h.deps.secondReview = { ...result.review, operationEnded: async () => { throw boom("MemberDown"); } };
    await expect(result.h.flow.recordResult({ workspaceId: WORKSPACE_ID, operationId: ran.operation!.id, fence: ran.operation!.fence, status: "FAILED", error: "stopped" })).rejects.toThrow("MemberDown");
    // The operation's end was committed before the member ran: it is ended, the hold is not given back (the member never ran its release).
    expect((await readOperation(result.h.deps, WORKSPACE_ID, ran.operation!.id))!.status).toBe("FAILED");
    expect(await result.money.stateOf(ran.operation!.secondReviewPlan!.reservationId)).toBe("open");

    const close = await reviewWorld();
    const running = await startReviewStep(close.h);
    close.h.deps.secondReview = { ...close.review, operationEnded: async () => { throw boom("MemberDown"); } };
    await expect(closeTask(close.h.deps, close.h.owner, TASK_ID)).rejects.toThrow("MemberDown");
    expect((await readTask(close.h.deps, TASK_ID))!.closedAt).toBeDefined();
    expect(await close.money.stateOf(running.operation!.secondReviewPlan!.reservationId)).toBe("open");
  });

  it("the laptop's proxy bookkeeping is caught at the result only (results.ts:97); at close.ts it is not called at all", async () => {
    const w = await reviewWorld();
    const { operation } = await startReviewStep(w.h);
    const proxy: string[] = [];
    w.h.deps.onOperationEnded = (operationId) => { proxy.push(operationId); throw boom("ProxyDown"); };
    await w.h.flow.recordResult({ workspaceId: WORKSPACE_ID, operationId: operation!.id, fence: operation!.fence, status: "FAILED", error: "stopped" });
    // The result did not fail, the proxy was asked once, and second review (called after it) still gave its hold back.
    expect(proxy).toEqual([operation!.id]);
    expect(await w.money.stateOf(operation!.secondReviewPlan!.reservationId)).toBe("released");
    // A close with an active operation calls second review but never the proxy.
    const closing = await reviewWorld();
    const running = await startReviewStep(closing.h);
    const seen: string[] = [];
    closing.h.deps.onOperationEnded = (operationId) => { seen.push(operationId); };
    await closeTask(closing.h.deps, closing.h.owner, TASK_ID);
    expect(seen).toEqual([]);
    expect(await closing.money.stateOf(running.operation!.secondReviewPlan!.reservationId)).toBe("released");
  });

  it("order at the result: proxy first, then second review; at close recovery: the engine's own release, then second review, then the proxy", async () => {
    const w = await reviewWorld();
    const { operation } = await startReviewStep(w.h);
    const order: string[] = [];
    w.h.deps.onOperationEnded = () => { order.push("proxy"); };
    w.h.deps.secondReview = { ...w.review, operationEnded: async (ended) => { order.push("second-review"); await w.review.operationEnded(ended); } };
    await w.h.flow.recordResult({ workspaceId: WORKSPACE_ID, operationId: operation!.id, fence: operation!.fence, status: "FAILED", error: "stopped" });
    expect(order).toEqual(["proxy", "second-review"]);

    const { w: c, money, reservationId } = await closeWithRunHold();
    const steps: string[] = [];
    const release = c.h.deps.admission.release.bind(c.h.deps.admission);
    c.h.deps.admission.release = async (id) => { if (id === reservationId) steps.push("engine-release"); await release(id); };
    c.h.deps.secondReview = { operationEnded: async () => { steps.push("second-review"); } } as never;
    c.h.deps.onOperationEnded = () => { steps.push("proxy"); };
    await c.h.flow.close(c.h.owner, c.task.taskId, c.input);
    c.restart(); await c.pump();
    expect(steps).toEqual(["engine-release", "second-review", "proxy"]);
    expect(await money.stateOf(reservationId)).toBe("released");
  });

  it("close recovery: a proxy that throws leaves the receipt unsaved and the close is retried (no engine catch); a second review member that throws does the same", async () => {
    for (const thrower of ["proxy", "member"] as const) {
      const { w, money, reservationId } = await closeWithRunHold();
      let failing = true;
      const calls: string[] = [];
      w.h.deps.secondReview = { operationEnded: async () => { calls.push("member"); if (failing && thrower === "member") throw boom("MemberDown"); } } as never;
      w.h.deps.onOperationEnded = () => { calls.push("proxy"); if (failing && thrower === "proxy") throw boom("ProxyDown"); };
      await w.h.flow.close(w.h.owner, w.task.taskId, w.input);
      w.restart();
      await w.pump().catch(() => undefined);
      // Nothing past the failing call ran, and the "reservations" receipt is not saved: the close is not complete.
      const first = await w.accepted();
      expect(first?.closeAcceptance?.receipts["reservations"], thrower).toBeUndefined();
      expect(first?.closeAcceptance?.phase).not.toBe("complete");
      // The reservation itself was released by the engine before any member ran, and stays released.
      expect(await money.stateOf(reservationId)).toBe("released");
      // Retried: the same calls again, now without the fault, and the close completes.
      failing = false;
      w.restart();
      for (let pass = 0; pass < 3; pass += 1) await w.pump();
      expect((await w.accepted())?.closeAcceptance?.phase, thrower).toBe("complete");
      expect(calls.filter((call) => call === "member").length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("prepare: propagates; the review step is not started, and the engine releases nothing for it", () => {
  it("a throwing prepare aborts the start (no operation, the workflow still waits for its review)", async () => {
    const w = await reviewWorld();
    w.h.deps.secondReview = { ...w.review, prepare: async () => { throw boom("PrepareDown"); } };
    const before = (await readTask(w.h.deps, TASK_ID))!.workflow!;
    await expect(startReview(w.h.deps, { taskId: TASK_ID, workflowRevision: before.revision })).rejects.toThrow("PrepareDown");
    expect((await workspaceOperations(w.h.deps, WORKSPACE_ID)).filter((entry) => entry.workflowMode === "REVIEW")).toEqual([]);
    const after = (await readTask(w.h.deps, TASK_ID))!.workflow!;
    expect(after).toMatchObject({ stage: "REVIEW", state: "WAITING", revision: before.revision });
    expect(await w.money.reserved()).toBe(0);
  });
});

describe("releaseHold: never throws, and says nothing", () => {
  it("a failing release while a failed start cleans up is swallowed: the step's own error is the one the caller sees, and nothing is logged for the release", async () => {
    const w = await reviewWorld();
    const real = w.review.deps.admission;
    w.review.deps.admission = { ...real, release: async () => { throw boom("ReleaseDown"); } };
    const restore = failAcceptingTheStep(w.h);
    await expect(startReviewStep(w.h)).rejects.toThrow("store down");
    restore();
    // service.releaseHold catches with no log (unlike operationEnded, which logs `second_review.release_failed`): the plan said "logged".
    expect(w.logs.filter((entry) => String(entry["event"]).includes("release"))).toEqual([]);
    expect(await w.money.reserved()).toBeGreaterThan(0);
    w.review.deps.admission = real;
  });
});

describe("opinionOf: a throw blocks the workflow, so the code is held and never passed", () => {
  it("the review result handler blocks the task at REVIEW (no opinion stored, no publication row); the same result with a working member passes", async () => {
    const control = await reviewWorld();
    const passed = await endReview(control.h, (await startReviewStep(control.h)).operation!);
    expect(passed.workflow).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });

    const w = await reviewWorld();
    const { operation } = await startReviewStep(w.h);
    w.h.deps.secondReview = { ...w.review, opinionOf: () => { throw boom("OpinionDown"); } };
    const task = await endReview(w.h, operation!);
    expect(task.workflow).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
    expect((task as { secondOpinion?: unknown }).secondOpinion).toBeUndefined();
    const rows = await w.h.store.query({ pk: `ORG#${COMPANY}#WORKFLOW_DISPATCH`, sk: { op: "beginsWith", prefix: `${TASK_ID}#` } });
    expect(rows.items.map((row) => row["kind"])).not.toContain("PUBLISH");
  });
});

describe("mergeWait: a throw propagates, so the merge is refused", () => {
  const down = () => { throw boom("MergeWaitDown"); };

  it("the confirm step, the press and the task view each fail with it; nothing is merged, claimed or shown", async () => {
    const world = await mergeWorld();
    await world.seedTracking();
    const pr = world.prs[0]!;
    // The confirm step (merge.ts:343 readinessFromItems is the view; the press reads merge.ts:689).
    await expect(prepareMerge({ ...world.deps, mergeWait: down }, { taskId: MERGE_TASK, requestId: world.requestId() })).rejects.toThrow("MergeWaitDown");
    const prepared = await world.prepare();
    await expect(pressMerge({ ...world.deps, mergeWait: down }, { taskId: MERGE_TASK, requestId: prepared.request.requestId, proof: world.proofFor(prepared) })).rejects.toThrow("MergeWaitDown");
    // The press asks twice (the confirm step's own read, then merge.ts:689 right before the merge): a member that fails only the second time refuses at the second.
    let asked = 0;
    const second = () => { asked += 1; if (asked >= 2) throw boom("MergeWaitDown"); return undefined; };
    await expect(pressMerge({ ...world.deps, mergeWait: second }, { taskId: MERGE_TASK, requestId: prepared.request.requestId, proof: world.proofFor(prepared) })).rejects.toThrow("MergeWaitDown");
    expect(asked).toBe(2);
    expect(pr.model.getChangeRequest(String(pr.number)).state).toBe("open");
    expect((await world.trackingOf(pr))!["mergeClaim"]).toBeUndefined();
    await expect(mergeViewOf({ ...world.deps, mergeWait: down }, await world.task(), await readMergeTracking(world.store, MERGE_TASK, MERGE_ORG), undefined)).rejects.toThrow("MergeWaitDown");
    // A refusal at the second ask comes AFTER the approval's proof was checked: that proof is spent (today), and the person approves again.
    await expect(pressMerge({ ...world.deps, mergeWait: () => undefined }, { taskId: MERGE_TASK, requestId: prepared.request.requestId, proof: world.proofFor(prepared) })).rejects.toThrow("already used");
    // Control: a new approval with a member that says nothing merges.
    const again = await world.prepare();
    const pressed = await pressMerge({ ...world.deps, mergeWait: () => undefined }, { taskId: MERGE_TASK, requestId: again.request.requestId, proof: world.proofFor(again) });
    expect(pressed.status).toBe("MERGED");
  });
});

describe("pullRequest: second review's prLines and prStatus propagate; the merge-order member and the design review's proof context are swallowed", () => {
  const lines = (calls: string[]) => ({
    prLines: () => { calls.push("prLines"); return ["Second review (openai/model-b): 1 blocking finding"]; },
    prStatus: () => { calls.push("prStatus"); return { state: "blocking" as const, count: 1, model: "openai/model-b", findings: [] }; },
  });

  it("publication (publish.ts:87): a throwing prLines or prStatus accepts no publish step; a throwing merge-order or proof context does not stop it", async () => {
    for (const member of ["prLines", "prStatus"] as const) {
      const w = await publicationWorld();
      w.h.deps.secondReview = { ...lines([]), [member]: () => { throw boom(`${member}Down`); } } as never;
      await expect(w.started()).rejects.toThrow(`${member}Down`);
      // No operation was accepted and the workspace was not taken.
      expect((await workspaceOperations(w.h.deps, w.task.workspaceId)).filter((entry) => entry.kind === "publish")).toEqual([]);
      expect((await w.h.store.get(w.workspace))?.activeOperationId).toBeNull();
    }
    const swallowed = await publicationWorld();
    swallowed.h.deps.mergeOrderLines = async () => { throw boom("MergeOrderDown"); };
    swallowed.h.deps.designReview = { proofContext: async () => { throw boom("ProofDown"); } } as never;
    const { result, operation } = await swallowed.started();
    expect(result).toBe("STARTED");
    expect(operation?.publication?.body).not.toContain("Merge the app pull request first.");
    // Control: a merge-order member that answers puts its line in the same description.
    const answered = await publicationWorld();
    answered.h.deps.mergeOrderLines = async () => ["Merge the app pull request first."];
    expect((await answered.started()).operation?.publication?.body).toContain("Merge the app pull request first.");
  });

  it("the sites: publication calls second review (inputs) once and the merge-order member (repository) once; the description inputs call second review only", async () => {
    const w = await publicationWorld();
    const calls: string[] = [];
    w.h.deps.secondReview = lines(calls) as never;
    const order = vi.fn(async (_task: unknown, repositoryId?: string) => { calls.push(`mergeOrder:${String(repositoryId)}`); return [] as string[]; });
    w.h.deps.mergeOrderLines = order;
    expect((await w.started()).result).toBe("STARTED");
    expect(calls.sort()).toEqual(["mergeOrder:app", "prLines", "prStatus"]);
    calls.length = 0;
    await descriptionInputsOf(w.h.deps, (await readTask(w.h.deps, w.task.taskId))!, w.task.workflow, w.candidate.digest);
    expect(calls.sort()).toEqual(["prLines", "prStatus"]);
  });

  it("the description inputs (changed-files.ts:217) propagate a throwing prLines; the Check's verdict source (pull-request-verdict.ts) answers nothing instead, and swallows a merge-order failure", async () => {
    const w = await host();
    const pr = w.world.prs[0]!;
    const task = (await readTask(w.h.deps, MERGE_TASK))!;
    const location = await workspaceKeys(w.h.deps, task.workspaceId);
    await w.world.store.put({ item: { ...verifiedFilesKey(location.workspaceKey, task.workflow!.candidate!.digest), entityType: "VERIFIED_FILES", candidateDigest: task.workflow!.candidate!.digest, complete: true, verifiedAt: "2026-11-09T10:00:00.000Z", files: [{ repository: "app", path: "src/a.ts", added: 3, removed: 1 }] } });
    expect(VERIFIED_FILES_KEPT_MAX).toBeGreaterThan(1);
    const input = { task: { ...task, orgId: ORG } as unknown as MergeTask, repositoryId: pr.repositoryId, number: pr.number, headSha: pr.head };
    const deps = w.h.deps as { secondReview?: unknown; mergeOrderLines?: unknown };
    const calls: string[] = [];
    deps.secondReview = lines(calls);
    deps.mergeOrderLines = async () => { calls.push("mergeOrder"); return ["Merge the app pull request first."]; };
    // The verdict source reads second review once (inputs) and merge order once (repository), as the description does.
    const verdict = await createPullRequestVerdictSource(w.h.deps)(input);
    expect(verdict?.body.join("\n")).toContain("Merge the app pull request first.");
    expect(calls.sort()).toEqual(["mergeOrder", "prLines", "prStatus"]);
    // A merge-order failure is swallowed (the verdict is still given, without its lines).
    deps.mergeOrderLines = async () => { throw boom("MergeOrderDown"); };
    expect((await createPullRequestVerdictSource(w.h.deps)(input))?.body.join("\n")).not.toContain("Merge the app pull request first.");
    // A second review that throws propagates out of the description inputs, and the verdict source (which catches everything) gives no verdict.
    deps.secondReview = { ...lines([]), prLines: () => { throw boom("PrLinesDown"); } };
    await expect(descriptionInputsOf(w.h.deps, task, task.workflow!, task.workflow!.candidate!.digest)).rejects.toThrow("PrLinesDown");
    expect(await createPullRequestVerdictSource(w.h.deps)(input)).toBeUndefined();
  });
});
