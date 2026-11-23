// DEC 254zzz334 / 375 / 398: a hosted paid-fix decision or Keep made with a tool's token (the CLI or an AI tool: a client that is not the Rovara web app) is audited as "made via tool", in the SAME shape as a plan
// approval from a tool: the audit event's `details.via` is "tool" (`auditViaCaller(audit, "tool")`, deployed-decisions.ts). A browser session's is not.
import { describe, expect, it } from "vitest";
import { WORKFLOW_KEEP_PULL_REQUESTS_NOTE, type AuditEvent } from "@agentx/contracts";
import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";
import { hostedFeedbackWorld } from "../support/hosted-pr-feedback-world.js";
import type { DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";

const kept = (events: AuditEvent[]) => events.filter(event => event.action === "task.feedback_decided" || event.action === "task.feedback_kept");
const browser = (caller: DeployedCaller): DeployedCaller => ({ ...caller, client: "rovara-web", webApp: true });

describe("a paid-fix decision or Keep made via a tool is audited as made via tool", () => {
  it("a tool-token Fix decision records via=tool, with the real actor", async () => {
    const w = await hostedFeedbackWorld();
    const response = await w.send("POST", "/workflow/feedback-decision", w.request);
    expect(response?.statusCode).toBe(200);
    const events = kept(w.h.audit);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "task.feedback_decided", actor: { type: "person", id: w.caller.principal.personId }, details: { decision: "APPROVE", via: "tool" } });
  });

  it("a browser-session Fix decision does NOT record via=tool", async () => {
    const w = await hostedFeedbackWorld();
    expect((await w.send("POST", "/workflow/feedback-decision", w.request, browser(w.caller)))?.statusCode).toBe(200);
    const events = kept(w.h.audit);
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe("task.feedback_decided");
    expect(events[0]!.details).not.toHaveProperty("via");
  });

  it("Keep (the decision route's DISMISS) via a tool records via=tool; in a browser it does not", async () => {
    const tool = await hostedFeedbackWorld("BLOCKED");
    const keep = { decision: "DISMISS", selectedFindingIds: [], ownerNote: WORKFLOW_KEEP_PULL_REQUESTS_NOTE };
    expect((await tool.send("POST", "/workflow/feedback-decision", { ...tool.request, ...keep }))?.statusCode).toBe(200);
    expect(kept(tool.h.audit)[0]).toMatchObject({ action: "task.feedback_decided", details: { decision: "DISMISS", via: "tool" } });
    const page = await hostedFeedbackWorld("BLOCKED");
    expect((await page.send("POST", "/workflow/feedback-decision", { ...page.request, ...keep }, browser(page.caller)))?.statusCode).toBe(200);
    expect(kept(page.h.audit)[0]!.details).not.toHaveProperty("via");
  });

  it("Keep on the keep-pull-requests route via a tool records via=tool; in a browser it does not", async () => {
    for (const via of ["tool", "browser"] as const) {
      const w = await hostedFeedbackWorld("BLOCKED");
      w.task.workflow!.feedbackReview = { status: "COLLECTING", bundleRefs: w.task.workflow!.feedbackReview!.bundleRefs, threadObservations: [] };
      await w.h.store.put({ item: toDocument(w.task) });
      const body = { requestId: w.request.requestId, expectedRevision: w.task.workflow!.revision };
      expect((await w.send("POST", "/workflow/keep-pull-requests", body, via === "tool" ? w.caller : browser(w.caller)))?.statusCode).toBe(200);
      const events = kept(w.h.audit);
      expect(events).toHaveLength(1);
      expect(events[0]!.action).toBe("task.feedback_kept");
      if (via === "tool") expect(events[0]!.details).toMatchObject({ via: "tool" });
      else expect(events[0]!.details).not.toHaveProperty("via");
    }
  });

  it("the stamp is the shared plan-approval shape: one short lower-case word on details.via", async () => {
    const { AuditViaSchema } = await import("@agentx/contracts");
    const w = await hostedFeedbackWorld();
    await w.send("POST", "/workflow/feedback-decision", w.request);
    expect(AuditViaSchema.safeParse(kept(w.h.audit)[0]!.details?.["via"]).success).toBe(true);
  });

  it("a refused tool decision stages no audit event", async () => {
    const w = await hostedFeedbackWorld();
    const answer = await w.send("POST", "/workflow/feedback-decision", { ...w.request, bundleDigests: ["0".repeat(64)] });
    expect(answer?.statusCode).toBeGreaterThanOrEqual(400);
    expect(kept(w.h.audit)).toEqual([]);
  });
  // R12: who acts, which task and which company come from the server-side caller and the path, never from the body.
  it.each(["feedback-decision", "keep-pull-requests"] as const)("%s: a body claiming webApp, another actor, task or company changes nothing", async route => {
    const w = await hostedFeedbackWorld("BLOCKED");
    if (route === "keep-pull-requests") {
      w.task.workflow!.feedbackReview = { status: "COLLECTING", bundleRefs: w.task.workflow!.feedbackReview!.bundleRefs, threadObservations: [] };
      await w.h.store.put({ item: toDocument(w.task) });
    }
    const real = route === "feedback-decision" ? w.request : { requestId: w.request.requestId, expectedRevision: w.task.workflow!.revision };
    const spoof = { ...real, webApp: true, via: "page", client: "rovara-web", actorId: "f".repeat(64), actorRole: "PROJECT_ADMIN", personId: "someone-else", taskId: "99999999-9999-4999-8999-999999999999", companyId: "org_bbbbbbbbbbbbbbbbbbbb", orgId: "org_bbbbbbbbbbbbbbbbbbbb" };
    const answer = await w.send("POST", `/workflow/${route}`, spoof);
    // The body is strict: claims of who acts, which task or company, or which client are refused whole, with nothing staged.
    expect(answer?.statusCode).toBe(400);
    expect(kept(w.h.audit)).toEqual([]);
    expect((await w.h.store.query({ pk: `ORG#${w.h.deps.companyId}#WORKFLOW_DISPATCH` })).items).toEqual([]);
  });

  it("a legal body whose own words claim to be the web app is still audited via=tool, as the real caller", async () => {
    const w = await hostedFeedbackWorld("BLOCKED");
    const body = { ...w.request, decision: "DISMISS", selectedFindingIds: [], ownerNote: `webApp:true client:rovara-web via:page actorId:${"f".repeat(64)}` };
    expect((await w.send("POST", "/workflow/feedback-decision", body))?.statusCode).toBe(200);
    const events = kept(w.h.audit);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: { type: "person", id: w.caller.principal.personId }, details: { via: "tool" } });
    expect(JSON.stringify(w.h.audit)).not.toContain(`"actorId":"${"f".repeat(64)}"`);
  });
});
