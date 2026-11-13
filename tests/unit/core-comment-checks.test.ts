// Lane L12 (owner decision 66): every safety check on a comment offered as a proof is Rovara's, decided from what the host fetched. One test for each check.
import { describe, expect, it } from "vitest";
import { ROVARA_REPLY_MARKER } from "@rovara-code/contracts";
import { checkCommentProof } from "../../packages/core/src/core/pr-commands/comment-checks.js";
import { ARTIFACT_DIGEST, THREAD, freshComment, threadContext } from "../support/comment-fakes.js";

const DANA = { provider: "examplehost", tenant: "", accountId: "dana" };
const check = (overrides: Parameters<typeof freshComment>[1] = {}, input: { outcome?: "approve" | "reject" | "request_changes"; context?: ReturnType<typeof threadContext> | undefined } = {}) =>
  checkCommentProof({ comment: freshComment(DANA, { ...overrides, body: (overrides.body ?? "/rovara approve __DIGEST__").replaceAll("__DIGEST__", "3f2a9c00") }), context: "context" in input ? input.context : threadContext(), artifactDigest: ARTIFACT_DIGEST, ...(input.outcome === undefined ? {} : { outcome: input.outcome }) });

describe("checkCommentProof: the checks a code-host plug-in never makes", () => {
  it("accepts a fresh, unedited approve on the request's own thread", () => {
    expect(check()).toEqual({ ok: true });
    expect(check({ body: "/rovara approve example/repo 3f2a9c00" })).toEqual({ ok: true });
    expect(check({ body: "/rovara approve 3F2A9C0000" })).toEqual({ ok: true });
  });
  it("refuses a comment on another change request or issue, or one that names another repository", () => {
    expect(check({ on: { ...THREAD, number: 13 } })).toEqual({ ok: false, reason: "comment_on_other_change" });
    expect(check({ on: { repository: "example/other", number: THREAD.number } })).toEqual({ ok: false, reason: "comment_on_other_change" });
    expect(check({ body: "/rovara approve example/other 3f2a9c00" })).toEqual({ ok: false, reason: "comment_on_other_change" });
  });
  it("refuses an approval that does not name the version, or names another one (the person read a different version)", () => {
    expect(check({ body: "/rovara approve" })).toEqual({ ok: false, reason: "comment_wrong_version" });
    expect(check({ body: "/rovara approve 1111111111" })).toEqual({ ok: false, reason: "comment_wrong_version" });
    expect(check({ body: "/rovara approve 3f2a" })).toEqual({ ok: false, reason: "comment_wrong_version" });
    // N3: the version is named by at least 8 hex characters (a true prefix of 32 bits); six are not enough.
    expect(check({ body: "/rovara approve 3f2a9c" })).toEqual({ ok: false, reason: "comment_wrong_version" });
    // A request for changes names no version.
    expect(check({ body: "/rovara changes: keep it" }, { outcome: "request_changes" })).toEqual({ ok: true });
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
    expect(check({ body: `Approved.\n\n${ROVARA_REPLY_MARKER}` })).toEqual({ ok: false, reason: "no_approving_comment" });
    // A person who quotes Rovara's reply under their own command is still giving a command: only the exact reply shape is Rovara's.
    expect(check({ body: `/rovara approve 3f2a9c00\n\n> Approved.\n>\n> ${ROVARA_REPLY_MARKER}` })).toEqual({ ok: true });
  });
  it("refuses a request that has no thread, and a comment that is gone", () => {
    expect(check({}, { context: undefined })).toEqual({ ok: false, reason: "no_request_thread" });
    expect(checkCommentProof({ comment: undefined, context: threadContext(), artifactDigest: ARTIFACT_DIGEST })).toEqual({ ok: false, reason: "no_approving_comment" });
  });
});
