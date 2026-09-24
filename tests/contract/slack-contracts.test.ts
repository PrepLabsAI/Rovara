import { describe, expect, it } from "vitest";
import {
  OperationSchema,
  SlackChannelBindingSchema,
  SlackRequesterSchema,
  SlackThreadSchema,
  SlackThreadWorkspaceResultSchema,
  parseSlackThreadSubject,
  slackThreadSubject,
} from "../../packages/contracts/src/index.js";

const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.123456" };

describe("Slack contracts", () => {
  it("accepts channel threads and rejects direct messages, malformed IDs, and unknown keys", () => {
    expect(SlackThreadSchema.parse(thread)).toEqual(thread);
    expect(SlackThreadSchema.parse({ ...thread, channelId: "G0123456789" }).channelId).toBe("G0123456789");
    expect(() => SlackThreadSchema.parse({ ...thread, channelId: "D0123456789" })).toThrow();
    expect(() => SlackThreadSchema.parse({ ...thread, teamId: "t0bshllugbd" })).toThrow();
    expect(() => SlackThreadSchema.parse({ ...thread, threadTs: "1695500000" })).toThrow();
    expect(() => SlackThreadSchema.parse({ ...thread, extra: true })).toThrow();
  });

  it("round-trips a thread through its owner subject and rejects extra segments", () => {
    const subject = slackThreadSubject(thread);
    expect(subject).toBe("T0BSHLLUGBD/C0123456789/1695500000.123456");
    expect(parseSlackThreadSubject(subject)).toEqual(thread);
    expect(() => parseSlackThreadSubject(`${subject}/extra`)).toThrow(/too many segments/);
    expect(() => parseSlackThreadSubject("T0BSHLLUGBD/D0123456789/1695500000.123456")).toThrow();
  });

  it("binds a channel to a project rather than to a revision", () => {
    const binding = {
      teamId: thread.teamId,
      channelId: thread.channelId,
      projectName: "payments",
      updatedAt: "2026-09-23T21:00:00.000Z",
    };
    expect(SlackChannelBindingSchema.parse(binding)).toEqual(binding);
    expect(() => SlackChannelBindingSchema.parse({ ...binding, projectRevision: 2 })).toThrow();
    expect(() => SlackChannelBindingSchema.parse({ ...binding, projectName: "Payments" })).toThrow();
  });

  it("describes thread workspace outcomes, including limit refusals", () => {
    expect(SlackThreadWorkspaceResultSchema.parse({
      outcome: "WORKSPACE",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      status: "PREPARING",
      operationId: "22222222-2222-4222-8222-222222222222",
      created: true,
      orchestratorInstructions: "Delegate work.",
    }).outcome).toBe("WORKSPACE");
    expect(SlackThreadWorkspaceResultSchema.parse({
      outcome: "LIMIT_REACHED",
      limit: "MEMBER",
      maximum: 3,
      starterThreads: [thread],
    }).outcome).toBe("LIMIT_REACHED");
    expect(() => SlackThreadWorkspaceResultSchema.parse({ outcome: "LIMIT_REACHED", limit: "TEAM", maximum: 3, starterThreads: [] }))
      .toThrow();
  });

  it("records the requesting Slack user on operations", () => {
    const operation = {
      id: "33333333-3333-4333-8333-333333333333",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      kind: "task",
      requestId: "44444444-4444-4444-8444-444444444444",
      payloadHash: "a".repeat(64),
      status: "ACCEPTED",
      fence: 1,
      createdAt: "2026-09-23T21:00:00.000Z",
      updatedAt: "2026-09-23T21:00:00.000Z",
      requestedBy: { teamId: thread.teamId, userId: "U0123456789" },
    };
    expect(OperationSchema.parse(operation).requestedBy).toEqual({ teamId: thread.teamId, userId: "U0123456789" });
    expect(() => SlackRequesterSchema.parse({ teamId: thread.teamId, userId: "B0123456789" })).toThrow();
  });
});
