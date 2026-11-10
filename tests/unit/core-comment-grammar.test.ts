// Lane L12 review: the words of a comment command (an approval names its version) and the one shape that is Rovara's own reply.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROVARA_REPLY_MARKER, isRovareReplyComment, parseRovaraComment } from "@agentx/contracts";

describe("/rovara approve names the version", () => {
  it("reads an optional repository and an optional digest of 6 to 12 hex characters", () => {
    expect(parseRovaraComment("/rovara approve")).toEqual({ kind: "approve" });
    expect(parseRovaraComment("/rovara approve 3F2A9C")).toEqual({ kind: "approve", digest: "3f2a9c" });
    expect(parseRovaraComment("/rovara approve example/repo")).toEqual({ kind: "approve", repo: "example/repo" });
    expect(parseRovaraComment("/rovara approve example/repo 3f2a9c0123")).toEqual({ kind: "approve", repo: "example/repo", digest: "3f2a9c0123" });
    // Too short or not hex: no digest was named.
    expect(parseRovaraComment("/rovara approve 3f2a")).toEqual({ kind: "approve" });
    expect(parseRovaraComment("/rovara approve please")).toEqual({ kind: "approve" });
  });
});

describe("Rovara's own reply is one exact shape (L11's L1)", () => {
  it("is a line, a blank line and the marker, and nothing else", () => {
    expect(isRovareReplyComment(`Approved.\n\n${ROVARA_REPLY_MARKER}`)).toBe(true);
    expect(isRovareReplyComment(`Approved.\r\n\r\n${ROVARA_REPLY_MARKER}\n`)).toBe(true);
    // A person who quotes the reply, or puts a command above it, wrote their own comment.
    expect(isRovareReplyComment(`/rovara approve 3f2a9c\n\nApproved.\n\n${ROVARA_REPLY_MARKER}`)).toBe(false);
    expect(isRovareReplyComment(`> Approved.\n>\n> ${ROVARA_REPLY_MARKER}`)).toBe(false);
    expect(isRovareReplyComment(`thanks @dana\n\n${ROVARA_REPLY_MARKER}`)).toBe(false);
    expect(isRovareReplyComment(ROVARA_REPLY_MARKER)).toBe(false);
  });
});

describe("docs", () => {
  it("names the approvers' comment reads as fetchComment and commentContext, not the removed verifyComment (L4)", () => {
    const text = readFileSync(`${process.cwd()}/docs/ports.md`, "utf8");
    expect(text).not.toContain("verifyComment");
  });
});
