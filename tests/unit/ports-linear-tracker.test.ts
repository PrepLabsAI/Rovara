// Port lane L2: the Linear Tracker adapter passes the same conformance suite as the fake, and a deliberately broken
// adapter fails the check that guards the behaviour it breaks. Linear's real deliveries are signed exactly as `Linear-Signature` is; no real key, workspace or token is used.
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { HostScope, RawDelivery } from "@agentx/contracts";
import { LINEAR_NO_READ_MESSAGE, linearTracker, type LinearIssueRead, type LinearStateType, type LinearTrackerAccess } from "../../packages/broker/src/plugins/tracker/linear/index.js";
import { linearIssueCreated } from "../../packages/broker/src/plugins/tracker/linear/webhook.js";
import { runContract } from "../support/ports/plugin-contract-kit.js";
import { SCOPE } from "../support/ports/plugin-fake-worlds.js";
import { trackerChecks, type TrackerWorld } from "../support/ports/tracker-conformance.js";
import { HOOK, NOW, SECRET, linearBody, signedLinear } from "../support/ports/linear-fixtures.js";

type OrgId = Extract<HostScope, { orgId: string }>["orgId"];
const ORG: OrgId = "org_aaaaaaaaaaaaaaaaaaaa";
type ReadableLinearAccess = LinearTrackerAccess & { readIssue: NonNullable<LinearTrackerAccess["readIssue"]> };
interface LinearWorld extends TrackerWorld {
  issues: Map<string, LinearIssueRead>;
  replies: Array<{ orgId: OrgId; issueKey: string; text: string }>;
  access: ReadableLinearAccess;
}

const STATE_OF: Record<string, LinearStateType> = { open: "unstarted", in_progress: "started", in_review: "started", done: "completed", cancelled: "canceled" };

function newAccess(): { access: ReadableLinearAccess; issues: Map<string, LinearIssueRead>; replies: LinearWorld["replies"] } {
  const issues = new Map<string, LinearIssueRead>();
  const replies: LinearWorld["replies"] = [];
  const access: ReadableLinearAccess = {
    reply: { reply: async (input) => { replies.push(input); } },
    readIssue: async (_orgId, key) => issues.get(key),
    hook: async () => ({ hook: HOOK, secret: SECRET }),
    installOrg: () => ORG,
  };
  return { access, issues, replies };
}

function linearWorld(): LinearWorld {
  const { access, issues, replies } = newAccess();
  const tracker = linearTracker(access);
  return {
    tracker, scope: SCOPE, issues, replies, access,
    addItem: (id, input) => {
      issues.set(id, { key: id, title: input?.title ?? `Issue ${id}`, description: input?.body ?? "", stateType: STATE_OF[input?.status ?? "open"] ?? "unstarted", ...(input?.assignee === undefined ? {} : { assignee: input.assignee }),
        labels: input?.labels ?? [], url: `https://linear.app/acme/issue/${id}/x` });
    },
    statusOf: () => undefined,
    commentsOf: (id) => replies.filter((reply) => reply.issueKey === id).map((reply) => reply.text),
  };
}

runContract("The Linear adapter passes the Tracker contract", trackerChecks, linearWorld);

describe("reading an item", () => {
  it("maps Linear's state to the neutral status, and returns the text as data, cut to the port's bounds", async () => {
    const w = linearWorld();
    for (const [state, status] of [["triage", "open"], ["backlog", "open"], ["unstarted", "open"], ["started", "in_progress"], ["completed", "done"], ["canceled", "cancelled"]] as const) {
      w.issues.set("ENG-1", { key: "ENG-1", title: "t", description: "d", stateType: state, labels: [], url: "https://linear.app/acme/issue/ENG-1" });
      expect((await w.tracker.readItem({ tracker: "linear", id: "ENG-1" }, SCOPE)).status).toBe(status);
    }
    w.issues.set("ENG-1", { key: "ENG-1", title: "t".repeat(5_000), description: "b".repeat(100_000), stateType: "started", labels: ["a", ""], url: "https://linear.app/acme/issue/ENG-1" });
    const item = await w.tracker.readItem({ tracker: "linear", id: "ENG-1" }, SCOPE);
    expect(item.title).toHaveLength(1_000);
    expect(item.body).toHaveLength(65_536);
    expect(item.labels).toEqual(["a"]);
  });

  it("refuses an answer for another issue than the one asked about, a link that is not Linear's is dropped, and no read means a fixed sentence", async () => {
    const w = linearWorld();
    w.issues.set("ENG-1", { key: "ENG-2", title: "other", description: "", stateType: "started", labels: [], url: "https://linear.app/acme/issue/ENG-2" });
    await expect(w.tracker.readItem({ tracker: "linear", id: "ENG-1" }, SCOPE)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    w.issues.set("ENG-3", { key: "ENG-3", title: "t", description: "", stateType: "started", labels: [], url: "https://evil.example.test/issue/ENG-3" });
    expect((await w.tracker.readItem({ tracker: "linear", id: "ENG-3" }, SCOPE)).ref.url).toBeUndefined();
    const noRead = linearTracker({ installOrg: () => ORG });
    await expect(noRead.readItem({ tracker: "linear", id: "ENG-1" }, SCOPE)).rejects.toMatchObject({ message: expect.stringContaining(LINEAR_NO_READ_MESSAGE) as string });
  });

  it("acts for the call's organization; a system scope with no install organization acts for none", async () => {
    const w = linearWorld();
    w.addItem("ENG-1");
    const read = vi.spyOn(w.access, "readIssue");
    await w.tracker.readItem({ tracker: "linear", id: "ENG-1" }, { orgId: "org_bbbbbbbbbbbbbbbbbbbb" });
    expect(read).toHaveBeenLastCalledWith("org_bbbbbbbbbbbbbbbbbbbb", "ENG-1");
    const orphan = linearTracker({ ...w.access, installOrg: undefined });
    await expect(orphan.readItem({ tracker: "linear", id: "ENG-1" }, SCOPE)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(orphan.comment!({ tracker: "linear", id: "ENG-1" }, "hi", SCOPE)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(w.replies).toEqual([]);
  });
});

describe("comments go through the reply port", () => {
  it("posts as Rovara on the issue, for the call's organization, and refuses an empty or oversized comment and a key that is not one", async () => {
    const w = linearWorld();
    await w.tracker.comment!({ tracker: "linear", id: "eng-7" }, "Opened a change request.", { orgId: ORG });
    expect(w.replies).toEqual([{ orgId: ORG, issueKey: "ENG-7", text: "Opened a change request." }]);
    for (const body of ["", "x".repeat(65_537)]) await expect(w.tracker.comment!({ tracker: "linear", id: "ENG-7" }, body, SCOPE)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(w.tracker.comment!({ tracker: "linear", id: "not a key" }, "hi", SCOPE)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(w.tracker.comment!({ tracker: "jira", id: "ENG-7" }, "hi", SCOPE)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(w.replies).toHaveLength(1);
  });
});

describe("a Linear delivery", () => {
  const normalise = (w: LinearWorld, delivery: RawDelivery) => w.tracker.events!.normalise!(delivery, SCOPE);

  it("becomes one labelled event per label of the issue created, from the same bytes the webhook rules read", async () => {
    const w = linearWorld();
    const body = linearBody({ labels: ["rovara", "bug"] });
    const events = await normalise(w, signedLinear(body));
    expect(events.map((event) => event.type)).toEqual(["item.labelled", "item.labelled"]);
    expect(events).toMatchObject([
      { tracker: "linear", item: { tracker: "linear", id: "ENG-1", url: "https://linear.app/acme/issue/ENG-1/x" }, label: "rovara", labelledBy: "user-dana" },
      { label: "bug" },
    ]);
    expect(new Set(events.map((event) => event.eventId)).size).toBe(2);
    // The same issue and labels the webhook rules find in the same body.
    const existing = linearIssueCreated(body, HOOK);
    expect("events" in existing && existing.events[0]).toMatchObject({ identifier: "ENG-1", labels: ["rovara", "bug"], actorId: "user-dana" });
    // Pinned: exactly these events for this body, so a change to the rules shows up here (until the trigger framework's copy is reconciled with this one).
    expect(events).toEqual([
      { eventId: events[0]!.eventId, tracker: "linear", item: { tracker: "linear", id: "ENG-1", url: "https://linear.app/acme/issue/ENG-1/x" }, type: "item.labelled", label: "rovara", labelledBy: "user-dana", occurredAt: new Date(NOW - 5_000).toISOString() },
      { eventId: events[1]!.eventId, tracker: "linear", item: { tracker: "linear", id: "ENG-1", url: "https://linear.app/acme/issue/ENG-1/x" }, type: "item.labelled", label: "bug", labelledBy: "user-dana", occurredAt: new Date(NOW - 5_000).toISOString() },
    ]);
    expect(events[0]!.eventId).toMatch(/^linear:issue:3f2b1c4e-0000-4000-8000-000000000001:create:label:[0-9a-f]{16}$/);
    // The same delivery again is the same events (a redelivery is held once by the intake engine, by these ids).
    expect((await normalise(w, signedLinear(body))).map((event) => event.eventId)).toEqual(events.map((event) => event.eventId));
  });

  it("refuses a forged or wrongly signed delivery before reading it, and a delivery for another Linear workspace or team", async () => {
    const w = linearWorld();
    const parse = vi.spyOn(JSON, "parse");
    for (const delivery of [signedLinear(linearBody(), "someone-elses-secret"), { ...signedLinear(linearBody()), headers: {} }, { ...signedLinear(linearBody()), headers: { "linear-signature": "0".repeat(64) } }]) {
      await expect(normalise(w, delivery)).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    }
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
    await expect(normalise(w, signedLinear(linearBody({ organizationId: "99999999-9999-4999-8999-999999999999" })))).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    await expect(normalise(w, signedLinear(linearBody({ teamId: "d1d1d1d1-1111-4111-8111-d1d1d1d1d1d1" })))).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
  });

  it("ignores what the webhook rules ignore (an update, a comment) and an issue with no key, and refuses a body that is not JSON or is too large", async () => {
    const w = linearWorld();
    expect(await normalise(w, signedLinear(linearBody({ action: "update" })))).toEqual([]);
    expect(await normalise(w, signedLinear(linearBody({ labels: [] })))).toEqual([]);
    const notJson = "{ not json";
    await expect(normalise(w, { rawBody: notJson, headers: { "linear-signature": createHmac("sha256", SECRET).update(notJson).digest("hex") } })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    const big = JSON.stringify({ pad: "x".repeat(1_100_000) });
    await expect(normalise(w, { rawBody: big, headers: { "linear-signature": createHmac("sha256", SECRET).update(big).digest("hex") } })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("is accepted only when the install gave the adapter a hook for the call's scope", async () => {
    const w = linearWorld();
    const none = linearTracker({ ...w.access, hook: async () => undefined });
    await expect(none.events!.normalise!(signedLinear(linearBody()), SCOPE)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(w.tracker.events!.normalise!(signedLinear(linearBody()), {} as never)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

// ---- the suite can fail: each broken adapter fails the check that guards what it breaks

describe("the Linear webhook rules the adapter carries", () => {

  it("believes a body for the hook's own workspace and team only; it ignores what is not an issue created, and what it cannot read", () => {
    expect(linearIssueCreated(linearBody({ organizationId: "other" }), HOOK)).toEqual({ tenantMismatch: true });
    expect(linearIssueCreated(linearBody({ teamId: "other" }), HOOK)).toEqual({ tenantMismatch: true });
    expect(linearIssueCreated("not an object", HOOK)).toEqual({ tenantMismatch: true });
    expect(linearIssueCreated(linearBody({ action: "update" }), HOOK)).toEqual({ ignored: "not an issue created" });
    const noTime = { ...linearBody(), webhookTimestamp: "soon" };
    expect(linearIssueCreated(noTime, HOOK)).toEqual({ ignored: "an issue that can't be read" });
    const longActor = { ...linearBody(), actor: { id: "u".repeat(201) } };
    expect(linearIssueCreated(longActor, HOOK)).toEqual({ ignored: "an issue that can't be read" });
  });

  it("names an issue by its team key and number when Linear gave no identifier, and drops a link that is not linear.app's", () => {
    const body = linearBody();
    const data = { ...(body.data as Record<string, unknown>), identifier: undefined, url: "https://evil.example.test/x" };
    const result = linearIssueCreated({ ...body, url: undefined, data }, HOOK);
    expect("events" in result && result.events[0]).toMatchObject({ identifier: "ENG-1" });
    expect("events" in result && result.events[0]?.url).toBeUndefined();
  });
});
