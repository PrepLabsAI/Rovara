// W1 on the real verify, feedback and reconcile (only the code host is a fake): a read that stalls cannot keep the tracking item from being written, and a rate limit of any class is not swallowed as "unavailable".
import { expect, it } from "vitest";
import { mergeTrackingKey, type CodeHost } from "@agentx/contracts";
import { host, ORG } from "../support/service-host.js";
import { TASK_ID } from "../support/merge-world.js";
import { recoveryRowKey } from "../../packages/broker/src/core/merge/store.js";
import { fixedCodeSettings } from "../../packages/broker/src/core/merge/defaults.js";
import { createMergeTrackingService, createMilestoneService } from "../../packages/broker/src/services/merge-tracking.js";
import { githubRequestContext, withGithubRequestContext } from "../../packages/broker/src/plugins/code-host/github/request-context.js";
import { GithubCompareRateLimitError, GithubMergeRateLimitError } from "../../packages/broker/src/plugins/code-host/github/client.js";

async function world() {
  const w = await host();
  w.h.deps.codeHosts = w.registry;
  const codeHost = w.registry.get("code-host", "github") as CodeHost;
  const tracking = createMergeTrackingService({
    flow: w.h.deps, registry: w.registry, companyId: ORG, milestones: createMilestoneService({ store: w.h.store, now: () => w.clock.ms }), people: w.people,
    settings: fixedCodeSettings({ allowSelfApproval: true, mergeMethod: "squash", codeReviewers: [], revision: 1 }), now: () => w.clock.ms, requestScope: withGithubRequestContext,
  });
  return { ...w, codeHost, tracking };
}

it("a changed-files read that hangs under the sweep ends with its phase: the tracking item is still written, the row says what is incomplete, and the next pass clears it", async () => {
  const w = await world();
  const fast = w.codeHost.changedFiles.bind(w.codeHost);
  w.codeHost.changedFiles = () => new Promise((_resolve, reject) => {
    const signal = githubRequestContext()?.signal;
    if (signal === undefined) { reject(new Error("no phase signal")); return; }
    signal.addEventListener("abort", () => reject(new Error("aborted by the phase")));
  });
  const at = w.clock.ms;
  expect(await w.tracking.sweep({ budgetMs: 1_500 })).toEqual({ attempted: 1 });
  // The item Merge reads exists (its risk stays high with the existing reason), so "I haven't finished reading this pull request" is gone.
  expect(await w.h.store.get(mergeTrackingKey(TASK_ID, "app", 1))).toBeDefined();
  expect(await w.h.store.get(recoveryRowKey(TASK_ID))).toMatchObject({ attempts: 1, readState: "github_read_incomplete", lastAttemptAt: at, nextAttemptAt: at + 60_000 });
  w.codeHost.changedFiles = fast;
  w.clock.ms += 61_000;
  await w.tracking.sweep({ budgetMs: 1_500 });
  const row = (await w.h.store.get(recoveryRowKey(TASK_ID)))!;
  expect(row["readState"]).toBeUndefined();
  expect(row["attempts"]).toBe(0);
});

it("a rate limit of GitHub's own class inside verify is not swallowed as 'unavailable': the sweep pauses until the time GitHub named", async () => {
  for (const make of [(until: number) => new GithubMergeRateLimitError(until), (until: number) => new GithubCompareRateLimitError(until)]) {
    const w = await world();
    const until = w.clock.ms + 10 * 60_000;
    w.codeHost.changedFiles = async () => { throw make(until); };
    expect(await w.tracking.sweep({ budgetMs: 1_500 })).toEqual({ attempted: 1 });
    expect(w.tracking.pausedUntil()).toBe(until);
    expect(await w.h.store.get(recoveryRowKey(TASK_ID))).toMatchObject({ attempts: 1, nextAttemptAt: until });
    expect(await w.tracking.sweep({ budgetMs: 1_500 })).toEqual({ attempted: 0 });
  }
});
