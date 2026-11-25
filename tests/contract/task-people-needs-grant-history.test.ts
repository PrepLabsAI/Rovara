// ARCH RULING (b), the task page's history: an owner a read demoted because they hold no grant of their own reads as one line of its own (no actor, never "made X commenter"), and the event stays readable by a
// reader that only checks the older fields.
import { describe, expect, it, vi } from "vitest";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { SLACK_OIDC_ISSUER, ownerNeedsGrantHistoryWords } from "@agentx/contracts";
import { getTaskDocumentView } from "../../packages/broker/src/aws/developer-tasks.js";
import { PEOPLE_RECONCILE_ACTOR } from "../../packages/broker/src/developer/task-people.js";
import { PRIYA, SAM, pagePlan, pageTask } from "../support/page-tasks.js";

const holder = vi.hoisted((): { store?: object } => ({}));
vi.mock("@rovara/aws-adapters", async () => ({ ...(await vi.importActual<Record<string, unknown>>("@rovara/aws-adapters")), DynamoDocumentStore: function () { return holder.store; } }));

describe("the task page's history for an owner demoted for want of a grant", () => {
  it("says who is now a commenter and why, with no actor, beside the ordinary role-change line; an older reader still reads the event", async () => {
    holder.store = new MemoryDocumentStore();
    const t = pageTask();
    t.addVersion("plan", pagePlan());
    const personId = "88888888-8888-4888-8888-888888888888";
    const identity = { developerId: SAM.developerId, slackUserId: SAM.slackUserId, name: SAM.name, method: "slack", issuer: SLACK_OIDC_ISSUER, subject: SAM.slackUserId };
    t.db.set({ pk: `DEVTASK#${t.taskId}`, sk: `PERSON#${personId}`, schemaVersion: 1, personId, ...identity, createdAt: "2026-10-11T09:00:00.000Z" });
    t.db.set({ pk: `DEVTASK#${t.taskId}`, sk: `PERSON_SUBJECT#${SAM.developerId}`, schemaVersion: 1, personId, developerId: SAM.developerId, createdAt: "2026-10-11T09:00:00.000Z" });
    const event = { entityType: "TASK_PEOPLE_EVENT", schemaVersion: 1, targetDeveloperId: SAM.developerId, beforeRole: "owner", afterRole: "commenter", createdAt: "2026-10-11T10:30:00.000Z" };
    t.db.set({ pk: `DEVTASK#${t.taskId}`, sk: "PEOPLE_EVENT#11111111-1111-4111-8111-111111111111", requestId: "11111111-1111-4111-8111-111111111111", actorDeveloperId: PEOPLE_RECONCILE_ACTOR, via: "needs_grant", ...event });
    // An ordinary role change by Priya, for comparison (and the older shape: no `via`).
    t.db.set({ pk: `DEVTASK#${t.taskId}`, sk: "PEOPLE_EVENT#22222222-2222-4222-8222-222222222222", requestId: "22222222-2222-4222-8222-222222222222", actorDeveloperId: PRIYA.developerId, ...event, createdAt: "2026-10-11T10:40:00.000Z" });
    const view = await getTaskDocumentView(t.deps, PRIYA, t.taskId);
    const lines = view.history.map((entry) => entry.text);
    expect(lines).toContain(ownerNeedsGrantHistoryWords("Sam Lee"));
    expect(lines).toContain("A task owner made Sam Lee commenter");
    // The demotion names no actor, so it is never read as someone's own act ("X made X commenter").
    expect(lines.filter((line) => line.includes("Sam Lee") && line.includes("made"))).toEqual(["A task owner made Sam Lee commenter"]);
    expect(ownerNeedsGrantHistoryWords("Sam Lee")).toBe("Sam Lee is now a commenter: only someone added to this project can own a task.");
  });
});
