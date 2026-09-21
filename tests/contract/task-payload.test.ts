import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { taskPayloadHash } from "../../packages/broker/src/task-payload.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

const candidateRequest = {
  requestId: "44444444-4444-4444-8444-444444444444",
  conversationId: "22222222-2222-4222-8222-222222222222",
  prompt: "Keep café labels",
  candidate: {
    jobId: "33333333-3333-4333-8333-333333333333",
    attempt: 1,
    repository: "demo",
    baseCommit: "a".repeat(40),
  },
};

const plainRequest = {
  requestId: "55555555-5555-4555-8555-555555555555",
  conversationId: "22222222-2222-4222-8222-222222222222",
  prompt: "Add a check",
};

describe("task payload hashing", () => {
  it("binds candidate fields and preserves the AWS hash", () => {
    const expected = sha(JSON.stringify({
      conversationId: candidateRequest.conversationId,
      prompt: candidateRequest.prompt,
      candidate: candidateRequest.candidate,
    }));
    expect(taskPayloadHash(candidateRequest)).toBe(expected);
    expect(taskPayloadHash({
      ...candidateRequest,
      candidate: { ...candidateRequest.candidate, baseCommit: "b".repeat(40) },
    })).not.toBe(expected);
  });

  it("preserves the accepted hash bytes for a request without a candidate", () => {
    expect(taskPayloadHash(plainRequest)).toBe(sha(JSON.stringify({
      conversationId: plainRequest.conversationId,
      prompt: plainRequest.prompt,
    })));
  });

  it("omits the candidate key entirely rather than serializing an absent one", () => {
    expect(taskPayloadHash(plainRequest)).not.toBe(sha(JSON.stringify({
      conversationId: plainRequest.conversationId,
      prompt: plainRequest.prompt,
      candidate: null,
    })));
    expect(taskPayloadHash({ ...plainRequest, candidate: undefined }))
      .toBe(taskPayloadHash(plainRequest));
  });

  it("hashes a non-ASCII prompt over its UTF-8 bytes", () => {
    const prompt = "Keep café labels — 日本語 🙂";
    const expected = sha(JSON.stringify({
      conversationId: plainRequest.conversationId,
      prompt,
    }));
    expect(taskPayloadHash({ ...plainRequest, prompt })).toBe(expected);
    expect(expected).toBe(createHash("sha256")
      .update(Buffer.from(JSON.stringify({
        conversationId: plainRequest.conversationId,
        prompt,
      }), "utf8"))
      .digest("hex"));
  });

  it("is stable when input keys arrive in a different order", () => {
    const reordered = {
      candidate: {
        baseCommit: candidateRequest.candidate.baseCommit,
        repository: candidateRequest.candidate.repository,
        attempt: candidateRequest.candidate.attempt,
        jobId: candidateRequest.candidate.jobId,
      },
      prompt: candidateRequest.prompt,
      conversationId: candidateRequest.conversationId,
      requestId: candidateRequest.requestId,
    };
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(candidateRequest));
    expect(taskPayloadHash(reordered)).toBe(taskPayloadHash(candidateRequest));
  });

  it("does not depend on the request identifier", () => {
    expect(taskPayloadHash({ ...candidateRequest, requestId: "66666666-6666-4666-8666-666666666666" }))
      .toBe(taskPayloadHash(candidateRequest));
  });

  it.each([
    ["an unknown candidate field", { ...candidateRequest, candidate: { ...candidateRequest.candidate, extra: "x" } }],
    ["an unknown top-level field", { ...candidateRequest, deadline: "2026-09-22T15:30:00Z" }],
    ["a malformed base commit", { ...candidateRequest, candidate: { ...candidateRequest.candidate, baseCommit: "zz" } }],
    ["an empty prompt", { ...candidateRequest, prompt: "" }],
  ])("rejects %s instead of hashing it", (_label, value) => {
    expect(() => taskPayloadHash(value as never)).toThrow();
  });

  it.each(["jobId", "attempt", "repository", "baseCommit"] as const)(
    "changes the hash when candidate.%s changes",
    (field) => {
      const changed = {
        jobId: "77777777-7777-4777-8777-777777777777",
        attempt: 2,
        repository: "other",
        baseCommit: "c".repeat(40),
      }[field];
      expect(taskPayloadHash({
        ...candidateRequest,
        candidate: { ...candidateRequest.candidate, [field]: changed },
      })).not.toBe(taskPayloadHash(candidateRequest));
    },
  );
});
