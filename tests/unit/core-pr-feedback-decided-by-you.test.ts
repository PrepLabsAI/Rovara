// DEC 254zzz398 (b): the served feedback decision says whether the READER made it (`decidedByYou`), computed by the server as the decision's actor === the reader's own owner key.
// The single contract addition (served only, never stored). The reader's key is never added to a view.
import { describe, expect, it } from "vitest";
import { WORKFLOW_KEEP_PULL_REQUESTS_NOTE, DeveloperTaskViewSchema } from "@agentx/contracts";
import { hostedFeedbackWorld, type FeedbackRouteBody } from "../support/hosted-pr-feedback-world.js";

const OTHER_KEY = "c".repeat(64);
const dismiss = (request: object) => ({ ...request, decision: "DISMISS", selectedFindingIds: [], ownerNote: WORKFLOW_KEEP_PULL_REQUESTS_NOTE });
async function decided() {
  const w = await hostedFeedbackWorld("COMPLETE");
  expect((await w.send("POST", "/workflow/feedback-decision", dismiss(w.request)))?.statusCode).toBe(200);
  return w;
}
const decisionsOf = (response: { body: string } | undefined) => (JSON.parse(response!.body) as FeedbackRouteBody).task.workflow.feedbackDecisions as Array<Record<string, unknown>>;
function asCoOwner(w: Awaited<ReturnType<typeof decided>>) {
  w.caller.principal = { ...w.caller.principal, personId: "co-owner-person", roles: ["member"] };
  w.h.deps.access.canRead = async () => true;
  w.h.deps.access.canAct = async () => true;
  w.h.deps.access.ownerActing = async () => ({ actorId: OTHER_KEY, authority: { actorId: OTHER_KEY, ownerIds: [OTHER_KEY] } });
}

describe("decidedByYou on the served feedback decision", () => {
  it("the owner who decided reads true, on the task read and on the decision's own response", async () => {
    const w = await decided();
    const read = decisionsOf(await w.send("GET"));
    expect(read).toHaveLength(1);
    expect(read[0]!["decidedByYou"]).toBe(true);
    expect(DeveloperTaskViewSchema.shape.workflow.safeParse((JSON.parse((await w.send("GET"))!.body) as FeedbackRouteBody).task.workflow).success).toBe(true);
    expect(decisionsOf(await w.send("POST", "/workflow/feedback-decision", dismiss(w.request)))[0]!["decidedByYou"]).toBe(true);
  });

  it("a co-owner who did not decide reads false (and never receives their own or the decider's key as a new field)", async () => {
    const w = await decided();
    asCoOwner(w);
    const read = await w.send("GET");
    expect(read?.statusCode).toBe(200);
    expect(decisionsOf(read)[0]!["decidedByYou"]).toBe(false);
    expect(read!.body).not.toContain(OTHER_KEY);
  });

  it("a co-owner who DID decide reads true; the original owner then reads false", async () => {
    const w = await hostedFeedbackWorld("COMPLETE");
    asCoOwner(w);
    expect((await w.send("POST", "/workflow/feedback-decision", dismiss(w.request)))?.statusCode).toBe(200);
    expect(decisionsOf(await w.send("GET"))[0]!["decidedByYou"]).toBe(true);
    w.caller.principal = { ...w.caller.principal, personId: w.task.developerId };
    w.h.deps.access.ownerActing = async () => ({ actorId: w.task.ownerKey });
    expect(decisionsOf(await w.send("GET"))[0]!["decidedByYou"]).toBe(false);
  });

  it("a script token is never the decider: false or absent", async () => {
    const w = await decided();
    const response = await w.send("GET", "", undefined, { ...w.caller, scriptToken: { tokenId: "script" } });
    if (response?.statusCode === 200) for (const decision of decisionsOf(response)) expect(decision["decidedByYou"] ?? false).toBe(false);
    else expect(response?.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("the feedback card's own decision says it too, and serves no actor key", async () => {
    const w = await decided();
    const mine = JSON.parse((await w.send("GET", "/workflow/feedback"))!.body) as { review: { decision: Record<string, unknown> } };
    expect(mine.review.decision["decidedByYou"]).toBe(true);
    expect(mine.review.decision).not.toHaveProperty("actorId");
    asCoOwner(w);
    const theirs = JSON.parse((await w.send("GET", "/workflow/feedback"))!.body) as { review: { decision: Record<string, unknown> } };
    expect(theirs.review.decision["decidedByYou"]).toBe(false);
  });

  it("the flag is served only: nothing stores it on the workflow", async () => {
    const w = await decided();
    const stored = (await w.h.store.get(w.task)) as unknown as { workflow: { feedbackDecisions: Array<Record<string, unknown>> } };
    expect(stored.workflow.feedbackDecisions.every(decision => !("decidedByYou" in decision))).toBe(true);
  });
});
