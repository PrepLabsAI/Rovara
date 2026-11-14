// Enterprise foundations P9: the intent source `tracker` is the neutral spelling of a ticket that asks for work; `linear`, `jira` and `github_issue` stay valid (dual read, no migration).
// A stored intent, session binding or task that says `linear` is read as the `linear` tracker's, and the schema accepts both spellings exactly as it did.
import { describe, expect, it } from "vitest";
import { CODE_INTENT_SOURCES, CodeIntentRequestSchema, TRACKER_INTENT_SOURCES, isTrackerIntentSource, trackerItemOfBinding, trackerOfCodeIntent } from "@agentx/contracts";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const base = { requestId: REQUEST_ID, project: "web", input: { text: "Fix it" } };
const linearIssue = { kind: "linear_issue" as const, issueId: "ENG-142", url: "https://linear.app/issue/ENG-142" };
const ticket = (system: string, id: string) => ({ kind: "tracker_item" as const, system, id, url: `https://tracker.example.test/${id}` });

describe("the ticket sources", () => {
  it("are the neutral one and the three older spellings, all valid sources", () => {
    expect([...TRACKER_INTENT_SOURCES].sort()).toEqual(["github_issue", "jira", "linear", "tracker"]);
    for (const source of TRACKER_INTENT_SOURCES) expect(CODE_INTENT_SOURCES).toContain(source);
    for (const source of TRACKER_INTENT_SOURCES) expect(isTrackerIntentSource(source)).toBe(true);
    for (const source of ["app", "cli", "mcp", "slack", "offer", "", "TRACKER"]) expect(isTrackerIntentSource(source)).toBe(false);
  });
});

describe("the tracker of an intent, whichever spelling it came in", () => {
  it("reads `linear` with a Linear binding and `tracker` naming linear as the same tracker and item", () => {
    const old = { source: "linear" as const, binding: linearIssue };
    const neutral = { source: "tracker" as const, binding: ticket("linear", "ENG-142") };
    expect(trackerOfCodeIntent(old)).toEqual({ tracker: "linear", id: "ENG-142" });
    expect(trackerOfCodeIntent(neutral)).toEqual({ tracker: "linear", id: "ENG-142" });
    expect(CodeIntentRequestSchema.safeParse({ ...base, ...old }).success).toBe(true);
    expect(CodeIntentRequestSchema.safeParse({ ...base, ...neutral }).success).toBe(true);
  });

  it("reads Jira and GitHub Issues by their fixed systems, and any other tracker by the system its binding names", () => {
    expect(trackerOfCodeIntent({ source: "jira", binding: ticket("jira", "PAY-12") })).toEqual({ tracker: "jira", id: "PAY-12" });
    expect(trackerOfCodeIntent({ source: "github_issue", binding: ticket("github", "acme/web#7") })).toEqual({ tracker: "github", id: "acme/web#7".replace("#", "#") });
    expect(trackerOfCodeIntent({ source: "tracker", binding: ticket("fake-tracker", "ENG-9") })).toEqual({ tracker: "fake-tracker", id: "ENG-9" });
  });

  it("names none for an intent that is not a ticket, or a ticket with no binding or a Slack binding", () => {
    expect(trackerOfCodeIntent({ source: "app" })).toBeUndefined();
    expect(trackerOfCodeIntent({ source: "linear" })).toBeUndefined();
    expect(trackerOfCodeIntent({ source: "tracker", binding: { kind: "slack_thread", teamId: "T0123456", channelId: "C0123456", threadTs: "1700000000.000100" } as never })).toBeUndefined();
    expect(trackerOfCodeIntent({ source: "app", binding: ticket("linear", "ENG-1") })).toBeUndefined();
  });

  it("changes nothing the schema decided before: `tracker` still refuses Jira and GitHub as its system, and `linear` still takes an assigner and no other source does", () => {
    expect(CodeIntentRequestSchema.safeParse({ ...base, source: "tracker", binding: ticket("jira", "PAY-1") }).success).toBe(false);
    expect(CodeIntentRequestSchema.safeParse({ ...base, source: "tracker", binding: ticket("github", "x") }).success).toBe(false);
    expect(CodeIntentRequestSchema.safeParse({ ...base, source: "linear", binding: linearIssue, assignedBy: { bot: false } }).success).toBe(true);
    expect(CodeIntentRequestSchema.safeParse({ ...base, source: "tracker", binding: ticket("linear", "ENG-1"), assignedBy: { bot: false } }).success).toBe(false);
  });
});

describe("a session binding, read for its tracker", () => {
  it("is the same item from a Linear binding and from a tracker binding naming linear; a Slack thread has none", () => {
    expect(trackerItemOfBinding(linearIssue)).toEqual({ tracker: "linear", id: "ENG-142", url: "https://linear.app/issue/ENG-142" });
    expect(trackerItemOfBinding(ticket("linear", "ENG-142"))).toMatchObject({ tracker: "linear", id: "ENG-142" });
    expect(trackerItemOfBinding({ kind: "slack_thread", teamId: "T0123456", channelId: "C0123456", threadTs: "1700000000.000100" } as never)).toBeUndefined();
  });
});
