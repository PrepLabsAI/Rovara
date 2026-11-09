// Lane L12 (owner decision 66): every safety check on a comment offered as a proof is Rovara's, decided from what the host fetched. One test for each check.
import { describe, expect, it } from "vitest";
import { ROVARA_REPLY_MARKER } from "@agentx/contracts";
import { checkCommentProof } from "../../packages/broker/src/core/pr-commands/comment-checks.js";
import { THREAD, freshComment, threadContext } from "../support/comment-fakes.js";

const DANA = { provider: "examplehost", tenant: "", accountId: "dana" };
const check = (overrides: Parameters<typeof freshComment>[1] = {}, input: { outcome?: "approve" | "reject" | "request_changes"; context?: ReturnType<typeof threadContext> | undefined } = {}) =>
  checkCommentProof({ comment: freshComment(DANA, overrides), context: "context" in input ? input.context : threadContext(), ...(input.outcome === undefined ? {} : { outcome: input.outcome }) });

describe("checkCommentProof: the checks a code-host plug-in never makes", () => {
  it("accepts a fresh, unedited approve on the request's own thread", () => {
    expect(check()).toEqual({ ok: true });
    expect(check({ body: "/rovara approve example/repo" })).toEqual({ ok: true });
  });
  it("refuses a comment on another change request or issue, or one that names another repository", () => {
    expect(check({ on: { ...THREAD, number: 13 } })).toEqual({ ok: false, reason: "comment_on_other_change" });
    expect(check({ on: { repository: "example/other", number: THREAD.number } })).toEqual({ ok: false, reason: "comment_on_other_change" });
    expect(check({ body: "/rovara approve example/other" })).toEqual({ ok: false, reason: "comment_on_other_change" });
  });
  it("refuses a comment written before the version was posted, and one whose time cannot be read", () => {
    expect(check({ createdAt: "2026-11-09T09:59:59.000Z", updatedAt: "2026-11-09T09:59:59.000Z" })).toEqual({ ok: false, reason: "comment_before_request" });
    expect(check({ createdAt: "soon", updatedAt: "soon" })).toEqual({ ok: false, reason: "comment_before_request" });
    expect(check({}, { context: threadContext({ postedAt: "never" }) })).toEqual({ ok: false, reason: "comment_before_request" });
  });
  it("refuses an edited comment, whatever it says now", () => {
    expect(check({ updatedAt: "2026-11-09T10:06:00.000Z" })).toEqual({ ok: false, reason: "comment_edited" });
  });
  it("refuses anything but the command for the answer, a bot, and Rovara's own reply", () => {
    expect(check({ body: "looks good" })).toEqual({ ok: false, reason: "no_approving_comment" });
    expect(check({ body: "/rovara changes: x" })).toEqual({ ok: false, reason: "no_approving_comment" });
    expect(check({ body: "/rovara approve" }, { outcome: "request_changes" })).toEqual({ ok: false, reason: "no_approving_comment" });
    expect(check({ body: "/rovara changes: keep it" }, { outcome: "request_changes" })).toEqual({ ok: true });
    expect(check({}, { outcome: "reject" })).toEqual({ ok: false, reason: "no_approving_comment" });
    expect(check({ authorIsBot: true })).toEqual({ ok: false, reason: "no_approving_comment" });
    expect(check({ body: `/rovara approve\n\n${ROVARA_REPLY_MARKER}` })).toEqual({ ok: false, reason: "no_approving_comment" });
  });
  it("refuses a request that has no thread, and a comment that is gone", () => {
    expect(check({}, { context: undefined })).toEqual({ ok: false, reason: "no_request_thread" });
    expect(checkCommentProof({ comment: undefined, context: threadContext() })).toEqual({ ok: false, reason: "no_approving_comment" });
  });
});
