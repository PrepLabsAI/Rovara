import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { agentSessionKey, type JsonValue, type OrgId } from "@agentx/contracts";
import { answerTaskFrame } from "../../packages/broker/src/core/answers/task-context.js";
import { createTaskSessionItems, taskSessionId } from "../../packages/broker/src/core/sessions/create.js";
import { SessionStore } from "../../packages/broker/src/core/sessions/store.js";
import type { TaskRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { A, B, T0 } from "../support/answer-world.js";

const TASK = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const at = new Date(T0).toISOString();
const doc = "# Checkout repair\n\nRepair the button and run the focused checks.";
const task = (over: Partial<TaskRecord> = {}) => ({ companyId: A, taskId: TASK, project: "alpha", ownerKey: "own", workspaceId: "ws", title: "Repair checkout", requestText: "Please repair checkout", workflow: { artifacts: [], decisions: [], stage: "PLAN", state: "RUNNING" }, ...over } as TaskRecord);
const frame = (store: MemoryDocumentStore, row: TaskRecord) => answerTaskFrame(store, A, row, { read: async () => row }, T0 + 60_000);

async function sessionWorld(companyId: OrgId = A, subjectTask = TASK) {
  const store = new MemoryDocumentStore();
  const sessionId = taskSessionId(TASK);
  await store.transact(createTaskSessionItems({ orgId: companyId, sessionId, taskId: subjectTask, project: "alpha", agent: { agentId: "rovara-code", name: "Rovara Code", version: 1 }, title: "Repair checkout", payer: { kind: "member", developerId: "a".repeat(64) } as never, owner: localOwnerPrincipal({ companyId }), origin: "app", now: at }));
  const sessions = new SessionStore(store);
  for (let n = 0; n < 55; n++) await sessions.appendEvent(companyId, sessionId, { eventId: `evt_${String(n).padStart(24, "0")}`, at: new Date(T0 + n * 1_000).toISOString(), type: "status", text: `VISIBLE-EVENT-${String(n).padStart(2, "0")}` });
  return { store, sessionId, task: task({ sessionId }) };
}

describe("task Answers web context", () => {
  it("reads the newest bounded task events in descending order", async () => {
    const x = await sessionWorld(); const shown = await frame(x.store, x.task);
    expect(shown).toContain("VISIBLE-EVENT-54"); expect(shown).toContain("VISIBLE-EVENT-35"); expect(shown).not.toContain("VISIBLE-EVENT-34");
    expect(shown.indexOf("VISIBLE-EVENT-54")).toBeLessThan(shown.indexOf("VISIBLE-EVENT-53"));
  });
  it.each(["company", "subject", "missing"])("never reads events from a %s session", async (kind) => {
    const x = await sessionWorld(kind === "company" ? B : A, kind === "subject" ? OTHER : TASK);
    if (kind === "company") {
      const other = await x.store.get(agentSessionKey(B, x.sessionId, "META"));
      await x.store.put({ item: { ...other!, ...agentSessionKey(A, x.sessionId, "META") } });
    }
    if (kind === "missing") await x.store.delete({ key: agentSessionKey(A, x.sessionId, "META") });
    expect(await frame(x.store, x.task)).not.toContain("VISIBLE-EVENT");
  });
  it("includes only the task's own digest-verified plan, never another workspace's document", async () => {
    const store = new MemoryDocumentStore(); const reads: string[] = [];
    const sha256 = createHash("sha256").update(doc).digest("hex");
    const row = task();
    const artifact = { type: "plan", version: 1, createdAt: at, sha256, objectKey: "private/own/ws/plan.md", contentType: "text/markdown" };
    row.workflow!.artifacts = [artifact as never];
    const tasks = { read: async () => row, artifacts: { get: async (key: string) => { reads.push(key); return new TextEncoder().encode(doc); } } };
    expect(await answerTaskFrame(store, A, row, tasks, T0)).toContain("Repair the button and run the focused checks.");
    reads.length = 0; artifact.objectKey = "private/other/other-ws/plan.md";
    expect(await answerTaskFrame(store, A, row, tasks, T0)).not.toContain("Repair the button and run the focused checks.");
    expect(reads).toEqual([]);
    artifact.objectKey = "private/own/ws/plan.md"; artifact.sha256 = "f".repeat(64);
    expect(await answerTaskFrame(store, A, row, tasks, T0)).not.toContain("Repair the button and run the focused checks.");
  });
  it("redacts and bounds the request and never loads diff, notes, or check tails", async () => {
    const store = new MemoryDocumentStore(); const key = ["AK", "IA", "IOSFODNN7EXAMPLE"].join("");
    const shown = await frame(store, task({ requestText: `${key}\n${"a".repeat(90_000)}\nHIDDEN-END-OF-REQUEST` }));
    expect(shown).not.toContain(key); expect(shown).not.toContain("HIDDEN-END-OF-REQUEST");
    expect(Buffer.byteLength(shown, "utf8")).toBeLessThan(25_000);
  });
  it("does not render an expired event even before physical deletion", async () => {
    const x = await sessionWorld();
    const events = await x.store.query({ pk: agentSessionKey(A, x.sessionId, "META").pk, sk: { op: "beginsWith", prefix: "EVENT#" }, descending: true, limit: 1 });
    await x.store.update({ key: events.items[0]!, ops: [{ op: "set", path: ["indexExpiresAt"], value: 0 as JsonValue }] });
    expect(await frame(x.store, x.task)).not.toContain("VISIBLE-EVENT-54");
  });
});

it("uses the current workflow stage even when the session summary is older", async () => {
  const x = await sessionWorld(); x.task.workflow!.stage = "IMPLEMENT";
  await x.store.update({ key: agentSessionKey(A, x.sessionId, "META"), ops: [{ op: "set", path: ["summary", "step"], value: "Old planning step" }] });
  const shown = await frame(x.store, x.task);
  expect(shown).toContain("Status: IMPLEMENT / RUNNING"); expect(shown).toContain("Current step: IMPLEMENT");
  expect(shown).not.toContain("Old planning step");
});

it("shows a closed task without presenting its previous stage as a running step", async () => {
  const x = await sessionWorld(); x.task.closedAt = at;
  const shown = await frame(x.store, x.task);
  expect(shown).toContain("Status: Closed"); expect(shown).not.toContain("Current step:");
});

it("keeps recent events and state visible beside a long request and plan summary", async () => {
  const x = await sessionWorld();
  const markdown = "# PLAN-START\n" + "Plan detail and verification instructions.\n".repeat(50) + "PLAN-BEYOND-SUMMARY\n" + "Plan detail.\n".repeat(1_500);
  x.task.requestText = "REQUEST-START\n" + "Request detail about the checkout repair.\n".repeat(50) + "REQUEST-BEYOND-SUMMARY\n" + "Request detail.\n".repeat(3_000);
  x.task.workflow!.artifacts = [{ type: "plan", version: 1, createdAt: at, sha256: createHash("sha256").update(markdown).digest("hex"), objectKey: "private/own/ws/plan.md", contentType: "text/markdown" } as never];
  const shown = await answerTaskFrame(x.store, A, x.task, { read: async () => x.task, artifacts: { get: async () => new TextEncoder().encode(markdown) } }, T0 + 60_000);
  for (const text of ["REQUEST-START", "PLAN-START", "Status: PLAN / RUNNING", "VISIBLE-EVENT-54", "VISIBLE-EVENT-35"]) expect(shown).toContain(text);
  expect(Buffer.byteLength(shown, "utf8")).toBeLessThan(25_000);
  expect(shown).not.toContain("REQUEST-BEYOND-SUMMARY"); expect(shown).not.toContain("PLAN-BEYOND-SUMMARY");
});
