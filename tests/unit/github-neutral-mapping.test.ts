// Port lane P2, item C4: GitHub's words become Rovara's at the adapter, and only there.
import { describe, expect, it } from "vitest";
import { GITHUB_ACTIONS_APP_ID } from "@agentx/contracts";
import { accountKindOf, checkOf, detailsOf, mergeableStateOf, statusOf } from "../../packages/broker/src/plugins/code-host/github/mapping.js";
import type { PullRequestStatus } from "../../packages/broker/src/github-pull-status.js";

const status = (over: Partial<PullRequestStatus> = {}): PullRequestStatus => ({
  number: 7, state: "open", draft: false, headSha: "a".repeat(40), baseBranch: "main", mergeableState: "clean", checks: [], requiredChecks: [], baseHasRequiredChecks: false, headHasWorkflowFiles: false,
  requestedReviewers: 0, reviews: [], ...over,
});

describe("the GitHub adapter speaks Rovara's words", () => {
  it("maps merge states: a conflict is `conflicted`, mergeable-with-hooks is `clean`, the rest keep their meaning", () => {
    expect(mergeableStateOf("dirty")).toBe("conflicted");
    expect(mergeableStateOf("has_hooks")).toBe("clean");
    for (const state of ["clean", "behind", "blocked", "unstable", "draft", "unknown"] as const) expect(mergeableStateOf(state)).toBe(state);
    expect(statusOf(status({ mergeableState: "dirty" })).mergeableState).toBe("conflicted");
  });

  it("maps account types: only a User is a person, a Bot is a bot, anything else (or nothing) is other", () => {
    expect(accountKindOf("User")).toBe("person");
    expect(accountKindOf("Bot")).toBe("bot");
    for (const type of ["Organization", "Mannequin", "", undefined, "user"]) expect(accountKindOf(type), String(type)).toBe("other");
    const reviews = [{ githubUserId: "5", login: "ana", userType: "User", state: "APPROVED", commitId: "a".repeat(40), submittedAt: "2026-11-09T08:00:00Z" }, { githubUserId: "6", login: "ci", userType: "", state: "COMMENTED", commitId: "a".repeat(40), submittedAt: "2026-11-09T08:00:00Z" }];
    expect(statusOf(status({ reviews: reviews as never })).reviews.map((review) => [review.reviewer.hostUserId, review.accountType])).toEqual([["5", "person"], ["6", "other"]]);
  });

  it("says a check's log can be read only for a GitHub Actions job (or a check naming no app) that has a job id", () => {
    const base = { name: "t", status: "completed" as const, conclusion: "failure" as const, required: false, url: "" };
    expect(checkOf({ ...base, jobId: "9", appId: GITHUB_ACTIONS_APP_ID }).logReadable).toBe(true);
    expect(checkOf({ ...base, jobId: "9" }).logReadable).toBe(true);
    expect(checkOf({ ...base, jobId: "9", appId: 5 }).logReadable).toBeUndefined();
    expect(checkOf({ ...base, appId: GITHUB_ACTIONS_APP_ID }).logReadable).toBeUndefined();
    // The app id stays an opaque `source` the core only compares.
    expect(checkOf({ ...base, jobId: "9", appId: 5 }).source).toBe("5");
  });

  it("carries who made a change request and which repository it is against only when GitHub said", () => {
    const details = { number: 7, url: "https://github.com/acme/app/pull/7", state: "open" as const, headBranch: "b", baseBranch: "main", headCommit: "a".repeat(40), title: "t", body: "" };
    expect(detailsOf("https://github.com/acme/app", details)).not.toHaveProperty("authoredByRovara");
    expect(detailsOf("https://github.com/acme/app", { ...details, authoredByApp: false, baseRepositoryId: "42" })).toMatchObject({ authoredByRovara: false, baseRepositoryId: "42" });
  });
});
