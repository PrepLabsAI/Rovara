// The live check for deciding and commenting on the task page (spec 061 slice 2): what the script checks by itself on a
// deployed task page, and the hands-on list it prints for a person to record.
import { describe, expect, it } from "vitest";
import { LIVE_CHECKLIST, pageChecks, stateChecks } from "../../scripts/plan-review-live-check.js";
import { createTaskWeb, type TaskDocumentView } from "../../packages/broker/src/aws/task-web.js";
import { planDocument } from "../support/plan-documents.js";

const taskId = "11111111-1111-4111-8111-111111111111";

async function ownerPage(): Promise<string> {
  const plan = planDocument({ decisions: [{ id: "d1", claimId: "1", question: "Where?", options: [{ id: "a", label: "Above", consequence: "Seen." }, { id: "b", label: "Below", consequence: "Quiet." }], recommended: "b" }] });
  const view: TaskDocumentView = {
    taskId, title: "Retry payments", status: "Waiting for your approval", nextStep: "Approve or request changes.", path: "QUICK", stage: "Coding plan", role: "owner",
    documents: [{ kind: "coding plan", version: 1, approved: false, current: true, format: "structured", plan }], checks: [], findings: [], pullRequests: [], history: [],
    revision: 3, commentSeq: 0, access: { role: "owner", canComment: true, canSuggest: false, canDecide: true, canAsk: true }, pageComments: [], pageSuggestions: [],
    waiting: { kind: "coding plan", version: 1, artifactDigest: "f".repeat(64) }, optionalChecks: [],
  };
  const web = createTaskWeb({ authenticateSession: async () => ({ developerId: "d".repeat(64), sessionId: "s", amr: "slack", name: "Maya" }), getTaskDocumentView: async () => view });
  const answer = await web({ method: "GET", path: `/review/${taskId}/task`, headers: { cookie: `__Host-agentx_review_session=${taskId}` }, requestId: "r" }, new URL(`https://agentx.example.test/review/${taskId}/task`));
  return answer.body;
}

describe("the task page live check", () => {
  it("passes the page the broker renders for an owner", async () => {
    const results = pageChecks(await ownerPage());
    expect(results.filter((result) => !result.ok)).toEqual([]);
    expect(results.map((result) => result.name)).toEqual(expect.arrayContaining([
      "fits a phone screen", "the decide bar clears the home indicator", "controls are thumb-sized", "the dialog is full screen on a phone",
      "long words wrap", "the page script is on the page", "the controls are hidden until the script runs",
    ]));
  });

  it("names what is missing", async () => {
    const html = (await ownerPage()).replace("env(safe-area-inset-bottom)", "0px").replace('id="agentx-page-data"', 'id="other"');
    const failed = pageChecks(html).filter((result) => !result.ok).map((result) => result.name);
    expect(failed).toEqual(["the decide bar clears the home indicator", "the page script is on the page"]);
  });

  it("reads the page's state answer: no names, no comment text, a fresh token", () => {
    expect(stateChecks({ revision: 3, waiting: true, stage: "Coding plan", documents: [{ anchor: "coding-plan", version: 1 }], commentSeq: 0, csrf: "c".repeat(43) }).every((result) => result.ok)).toBe(true);
    const bad = stateChecks({ revision: 3, waiting: true, stage: "Coding plan", documents: [], commentSeq: 0, name: "Maya", text: "hi" });
    expect(bad.filter((result) => !result.ok).map((result) => result.name)).toEqual(["carries a fresh token", "carries only where the task stands"]);
  });

  it("the hands-on list covers each case the plan asks a person to try", () => {
    const text = LIVE_CHECKLIST.join("\n");
    for (const item of ["390", "in-app browser", "Ask AgentX", "Android", "dark mode", "Keyboard only", "VoiceOver", "second person", "Request changes", "Full"]) {
      expect(text).toContain(item);
    }
    expect(text).not.toMatch(/\b(candidate|revision|digest|operation|artifact|workflow)\b/i);
  });
});
