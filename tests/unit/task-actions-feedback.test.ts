// S1: the owner's choices on PR feedback as registry moves, on the hosted PR feedback world (a finished feedback review waiting for the owner, over the real flow): fix the recommended findings or the ones picked, dismiss the comments and
// keep the pull request, answer in the owner's own words (the engine's request-changes decision with a note, which the web card never sent), retry a review that did not finish, and keep the pull request while the review is collecting.
import { describe, expect, it } from "vitest";
import { WORKFLOW_KEEP_PULL_REQUESTS_NOTE, type ActionDescription } from "@agentx/contracts";
import { describeAction, performRegistryAction, stateOffers, type ActionCaller } from "../../packages/broker/src/core/task-actions/index.js";
import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";
import { hostedFeedbackWorld } from "../support/hosted-pr-feedback-world.js";

const setup = async (status: "COMPLETE" | "BLOCKED" = "COMPLETE") => {
  const w = await hostedFeedbackWorld(status);
  const caller: ActionCaller = { principal: w.h.owner.principal, client: "slack" };
  const env = { deps: w.h.deps, options: {} };
  const binding = async (id: string) => (await stateOffers(env, (await w.h.store.get({ pk: `DEVTASK#${w.task.taskId}`, sk: "META" })) as never)).find((offer) => offer.id === id)?.binding;
  const press = (actionId: string, extra: Record<string, unknown> = {}) => binding(actionId).then((bound) => performRegistryAction(env, caller, { actionId, taskId: w.task.taskId, binding: bound, requestKey: `k-${actionId}-${String(Math.random())}`, via: "slack", ...extra }));
  return { w, caller, env, binding, press };
};
const decisionsOf = (w: Awaited<ReturnType<typeof hostedFeedbackWorld>>) => w.h.audit.filter((event) => event.action === "task.feedback_decided");
const ok = (description: ActionDescription) => { expect(description.status).toBe("ok"); return description as Extract<ActionDescription, { status: "ok" }>; };

describe("PR feedback moves", () => {
  it("offers the three choices for a finished review, not the retry, and describes the findings with the recommended ones chosen", async () => {
    const { w, env, caller, binding } = await setup();
    const task = (await w.h.store.get({ pk: `DEVTASK#${w.task.taskId}`, sk: "META" }))!;
    const ids = (await stateOffers(env, task as never)).map((offer) => offer.id);
    expect(ids).toEqual(expect.arrayContaining(["feedback.fix", "feedback.dismiss", "feedback.answer"]));
    expect(ids).not.toContain("feedback.retry-review");
    const described = ok(await describeAction(env, caller, { actionId: "feedback.fix", taskId: w.task.taskId, binding: await binding("feedback.fix") }));
    const field = described.spec.fields[0]!;
    expect(field.kind).toBe("pick-many");
    if (field.kind === "pick-many") expect(field.options.filter((option) => option.selected === true).map((option) => option.value).sort()).toEqual([...w.request.selectedFindingIds].sort());
  });

  it("fixes the recommended findings (a paid round), dismisses and keeps, and records each as Slack's", async () => {
    const fix = await setup();
    expect(await fix.press("feedback.fix")).toMatchObject({ status: "started" });
    expect(decisionsOf(fix.w)[0]).toMatchObject({ details: { decision: "APPROVE", via: "slack" }, actor: { type: "person", id: fix.caller.principal.personId } });
    const dismiss = await setup();
    expect(await dismiss.press("feedback.dismiss")).toMatchObject({ status: "done" });
    expect(decisionsOf(dismiss.w)[0]).toMatchObject({ details: { decision: "DISMISS", via: "slack" } });
    expect((dismiss.w.h.audit.find((event) => event.action === "task.feedback_decided")?.details as { selected?: number }).selected).toBe(0);
  });

  it("answers in the owner's own words: a note is required, and the feedback is reviewed again", async () => {
    const { w, press } = await setup();
    expect(await press("feedback.answer")).toMatchObject({ status: "refused", reason: "needs_input", writes: "none" });
    expect(decisionsOf(w)).toHaveLength(0);
    expect(await press("feedback.answer", { values: { note: "Both of these are intended; keep the retry." } })).toMatchObject({ status: "started" });
    expect(decisionsOf(w)[0]).toMatchObject({ details: { decision: "REQUEST_CHANGES", via: "slack" } });
  });

  it("refuses a card for an older review, with nothing written", async () => {
    const { w, press } = await setup();
    expect(await press("feedback.fix", { binding: { revision: 99, digest: "f".repeat(64) } })).toMatchObject({ status: "refused", reason: "stale", writes: "none" });
    expect(decisionsOf(w)).toHaveLength(0);
  });

  it("retries a review that did not finish, and keeps the pull request while the review is collecting", async () => {
    const failed = await setup("BLOCKED");
    const task = (await failed.w.h.store.get({ pk: `DEVTASK#${failed.w.task.taskId}`, sk: "META" }))!;
    const ids = (await stateOffers(failed.env, task as never)).map((offer) => offer.id);
    expect(ids).toEqual(expect.arrayContaining(["feedback.retry-review"]));
    expect(ids).not.toContain("feedback.fix");
    // Retrying the review is a paid round started in Slack's name; the same press again answers once.
    const retried = await failed.press("feedback.retry-review");
    expect(retried.status).toBe("started");
    expect(failed.w.h.audit.some((event) => event.action === "task.feedback_decided")).toBe(false);
    const collecting = await setup("BLOCKED");
    collecting.w.task.workflow!.feedbackReview = { status: "COLLECTING", bundleRefs: collecting.w.task.workflow!.feedbackReview!.bundleRefs, threadObservations: [] };
    await collecting.w.h.store.put({ item: toDocument(collecting.w.task) });
    expect(await collecting.press("pull-request.keep")).toMatchObject({ status: "done" });
    expect(collecting.w.h.audit.some((event) => event.action === "task.feedback_kept" && (event.details as { via?: string }).via === "slack")).toBe(true);
    expect(WORKFLOW_KEEP_PULL_REQUESTS_NOTE).toContain("kept");
  });
});
