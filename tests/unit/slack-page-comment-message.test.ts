// The queue message that asks the Slack service to answer a task page comment, and how an older service treats it.
import { describe, expect, it } from "vitest";
import {
  SLACK_ROUTE_ATTRIBUTE, SLACK_ROUTE_PAGE_COMMENT, SlackCommentAnsweredRequestSchema, SlackPageCommentMessageSchema, SlackRequestMessageSchema,
  SlackTaskAnswerRequestSchema, pageCommentAttributes, pageCommentEventId, routeOf, taskQuestionOf,
} from "@agentx/contracts";

const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const commentId = "6c1f5d7e-4ab0-4d43-9c55-2f0a3c9e2b11";
const thread = { teamId: "T123", channelId: "C123", threadTs: "1760000000.000100" };
const message = {
  version: 1, eventId: pageCommentEventId(commentId), thread, userId: "U123", text: "Why three retries?",
  receivedAt: "2026-10-11T10:00:00.000Z", pageComment: { taskId, commentId },
};

describe("page comment queue message", () => {
  it("an older service's schema refuses a page-comment message", () => {
    expect(SlackPageCommentMessageSchema.parse(message)).toEqual(message);
    expect(SlackRequestMessageSchema.safeParse(message).success).toBe(false);
    // The route attribute is one an older service does not act on: it is neither a routed request nor a task question.
    const attributes = pageCommentAttributes();
    expect(attributes[SLACK_ROUTE_ATTRIBUTE]).toEqual({ DataType: "String", StringValue: SLACK_ROUTE_PAGE_COMMENT });
    expect(routeOf(attributes)).toBeUndefined();
    expect(taskQuestionOf(attributes)).toBeUndefined();
    expect(SlackPageCommentMessageSchema.safeParse({ ...message, pageComment: { taskId, commentId, extra: 1 } }).success).toBe(false);
  });

  it("the page-comment event ID is stable and matches Slack's event ID form", () => {
    const id = pageCommentEventId(commentId);
    expect(id).toMatch(/^Ev[0-9a-f]{32}$/);
    expect(pageCommentEventId(commentId)).toBe(id);
    expect(pageCommentEventId("0d6a4c2b-91f3-4e57-8a2c-7b5e1f9d3a40")).not.toBe(id);
    expect(SlackRequestMessageSchema.shape.eventId.safeParse(id).success).toBe(true);
  });

  it("task mode may name the comment being answered, and the answer is written back strictly", () => {
    expect(SlackTaskAnswerRequestSchema.parse({ taskId })).toEqual({ taskId });
    expect(SlackTaskAnswerRequestSchema.parse({ taskId, commentId })).toEqual({ taskId, commentId });
    expect(SlackTaskAnswerRequestSchema.safeParse({ taskId, commentId: "c1" }).success).toBe(false);
    expect(SlackCommentAnsweredRequestSchema.safeParse({ taskId, commentId, thread, outcome: "ANSWERED", text: "Because most timeouts clear." }).success).toBe(true);
    expect(SlackCommentAnsweredRequestSchema.safeParse({ taskId, commentId, thread, outcome: "ANSWERED", text: "x".repeat(3_001) }).success).toBe(false);
    expect(SlackCommentAnsweredRequestSchema.safeParse({ taskId, commentId, thread, outcome: "FAILED" }).success).toBe(true);
    expect(SlackCommentAnsweredRequestSchema.safeParse({ taskId, commentId, thread, outcome: "FAILED", text: "x" }).success).toBe(false);
  });
});
