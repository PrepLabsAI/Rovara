// Port lane P2, item C4: GitHub's words become Rovara's at the adapter, and only there.
import { describe, expect, it } from "vitest";
import { GITHUB_ACTIONS_APP_ID } from "@agentx/contracts";
import { checkOf, mergeableStateOf, statusOf } from "../../packages/broker/src/plugins/code-host/github/mapping.js";
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

  it("says a check's log can be read only for a GitHub Actions job (or a check naming no app) that has a job id", () => {
    const base = { name: "t", status: "completed" as const, conclusion: "failure" as const, required: false, url: "" };
    expect(checkOf({ ...base, jobId: "9", appId: GITHUB_ACTIONS_APP_ID }).logReadable).toBe(true);
    expect(checkOf({ ...base, jobId: "9" }).logReadable).toBe(true);
    expect(checkOf({ ...base, jobId: "9", appId: 5 }).logReadable).toBeUndefined();
    expect(checkOf({ ...base, appId: GITHUB_ACTIONS_APP_ID }).logReadable).toBeUndefined();
    // The app id stays an opaque `source` the core only compares.
    expect(checkOf({ ...base, jobId: "9", appId: 5 }).source).toBe("5");
  });
});
