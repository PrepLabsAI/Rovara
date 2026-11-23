import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SLACK_CHANNEL, createWorkflowSnapshot, type ChannelAdapter, type ChannelEvent, type StoredDocument, type WorkflowSnapshot } from "@agentx/contracts";
import { hostedSlackThreads } from "../../packages/broker/src/aws/slack-thread-channel.js";
import { workflowThreadRefresh } from "../../packages/broker/src/core/channel/workflow-notices.js";
import { recordTaskThread } from "../../packages/broker/src/core/channel/threads.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { taskSessionId } from "../../packages/broker/src/core/sessions/create.js";
import { workflowMessage } from "../../packages/broker/src/developer/workflow-messages.js";
import { createFakeWorld, FAKE_COMPANY } from "../support/core-host-fakes.js";

async function world() {
  const fake = createFakeWorld();
  const taskId = randomUUID();
  const sessionId = taskSessionId(taskId);
  const events: ChannelEvent[] = [];
  let member = true;
  let company: string = FAKE_COMPANY;
  let fails = false;
  const adapter: ChannelAdapter = { capabilities: { threads: true, buttons: 5, edits: true, maxTextLength: 40000, proactive: true }, projects: [], stepUp: [],
    async deliver(event) { if (fails) throw new Error("offline"); events.push(event); } };
  const workflow = { ...createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now: new Date(fake.clock.now).toISOString(), definitionVersion: "1.1.0" }), stage: "IMPLEMENT", state: "RUNNING", revision: 5 } as WorkflowSnapshot;
  const put = async (value: WorkflowSnapshot) => fake.store.put({ item: JSON.parse(JSON.stringify({ ...taskKey(taskId), entityType: "DEVELOPER_TASK", taskId, companyId: FAKE_COMPANY, orgId: FAKE_COMPANY, sessionId, workflow: value })) as StoredDocument });
  await put(workflow);
  await recordTaskThread({ store: fake.store, orgId: FAKE_COMPANY, now: () => fake.clock.now }, { sessionId, personId: "dev-a", actor: { channel: SLACK_CHANNEL, tenant: "T0123456789", userId: "U0123456789" }, conversation: { channel: SLACK_CHANNEL, tenant: "T0123456789", space: "C0123456789", thread: "1700000000.000001" } });
  const threads = hostedSlackThreads({ workspaces: { requireCompany: async () => FAKE_COMPANY, tokenForCompany: async () => undefined } });
  const refresh = workflowThreadRefresh({ messageOf: (message) => threads.messageOf!(message), store: fake.store, companyId: FAKE_COMPANY, now: () => fake.clock.now,
    taskUrl: () => "https://app.example/app/sessions/" + sessionId, registry: { get: (() => adapter) as never }, companyOf: async () => company, isMember: async () => member });
  return { fake, workflow, put, events, refresh: () => refresh(FAKE_COMPANY, sessionId, taskId), member: (value: boolean) => { member = value; }, company: (value: string) => { company = value; }, fails: (value: boolean) => { fails = value; } };
}

describe("core workflow thread notices", () => {
  it("ports the existing workflow words into the task's recorded thread, once", async () => {
    const w = await world();
    await w.refresh(); await w.refresh();
    expect(w.events).toHaveLength(1);
    expect(w.events[0]).toMatchObject({ type: "message", conversation: { thread: "1700000000.000001" } });
    const event = w.events[0]!;
    if (event.type !== "message") throw new Error("not a workflow notice");
    expect(event.data.text).toContain(workflowMessage({ taskId: "irrelevant", workflow: w.workflow })!.text);
  });
  it("refuses foreign tenants and removed members without consuming the notice", async () => {
    const w = await world();
    w.company("org_bbbbbbbbbbbbbbbbbbbb"); await w.refresh();
    w.company(FAKE_COMPANY); w.member(false); await w.refresh();
    expect(w.events).toEqual([]);
    w.member(true); await w.refresh(); expect(w.events).toHaveLength(1);
  });
  it("retries a failed delivery even when the session summary has not changed", async () => {
    const w = await world(); w.fails(true);
    await expect(w.refresh()).rejects.toThrow("offline");
    w.fails(false); await w.refresh(); expect(w.events).toHaveLength(1);
  });
  it("leaves the existing four moments to their own handler", async () => {
    const w = await world();
    for (const [stage, state] of [["PLAN_REVIEW", "WAITING"], ["WAIT_FOR_MERGE", "WAITING"], ["MERGED", "COMPLETE"], ["CLOSED", "COMPLETE"]] as const) {
      await w.put({ ...w.workflow, stage, state }); await w.refresh();
    }
    expect(w.events).toEqual([]);
  });
});

it.each(["IMPLEMENT", "VERIFY", "REVIEW", "PULL_REQUEST"] as const)("review3: %s notices omit retired controls that refuse core owners and retain the task page", async (stage) => {
  const w = await world();
  const workflow = { ...w.workflow, stage, state: "BLOCKED" as const };
  // Negative control: these are actionable legacy cards, rather than an already buttonless moment.
  expect(workflowMessage({ taskId: "irrelevant", workflow })!.blocks.some((block) => block["type"] === "actions")).toBe(true);
  await w.put(workflow);
  await w.refresh();
  expect(w.events).toHaveLength(1);
  const event = w.events[0]!;
  expect(event.type).toBe("message");
  if (event.type !== "message") throw new Error("not a workflow notice");
  expect(event.data.actions ?? []).toEqual([]);
  expect((event.data.parts ?? []).filter((part) => part.type === "actions")).toEqual([]);
  expect(event.data.text).toContain("https://app.example/app/sessions/");
  expect((event.data.parts ?? []).some((part) => part.type === "section" && part.text.includes("https://app.example/app/sessions/"))).toBe(true);
});
