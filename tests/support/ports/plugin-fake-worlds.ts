// Worlds for the fakes: each builds a fresh model and the adapter over it. The contract suites run on these, and so do the mutants.
import { FakeCheckRunner } from "../../../packages/broker/src/plugins/fake/check-runner.js";
import { FakeCodeHost, fakeSignedDelivery } from "../../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../../packages/broker/src/plugins/fake/model.js";
import { FakeTracker, fakeTrackerDelivery } from "../../../packages/broker/src/plugins/fake/tracker.js";
import type { CheckRunnerWorld } from "./check-runner-conformance.js";
import type { CodeHostWorld } from "./code-host-conformance.js";
import type { TrackerWorld } from "./tracker-conformance.js";

export const REPO_URL = "https://git.example.test/acme/app";
export const OTHER_URL = "https://git.example.test/acme/other";
export const SCOPE = { system: "install" } as const;

export const newModel = () => new FakeHostModel({ url: REPO_URL, id: "4242", fullName: "acme/app" });

export function codeHostWorldFor(host: FakeCodeHost): CodeHostWorld {
  return {
    host, model: host.model, repository: { url: REPO_URL }, unregistered: { url: OTHER_URL }, scope: SCOPE,
    now: () => Date.parse(host.model.now()),
    branch: (n) => `rovara/feature-${String(n)}`,
    signedDelivery: (event) => fakeSignedDelivery(event.kind === "change_request.opened"
      ? { delivery: "d-1", event: "cr.opened", cr: event.id }
      : { delivery: "d-2", event: "push", branch: event.branch, revision: event.revision }),
    forgedDelivery: () => ({ ...fakeSignedDelivery({ delivery: "d-3", event: "cr.opened", cr: "1" }), headers: { "x-fake-signature": `sha256=${"0".repeat(64)}` } }),
    limitReads: (retryAt) => { host.model.rateLimitedUntil = retryAt; },
  };
}

export const fakeCodeHostWorld = (): CodeHostWorld => codeHostWorldFor(new FakeCodeHost(newModel()));

export function checkRunnerWorldFor(runner: FakeCheckRunner): CheckRunnerWorld {
  const host = new FakeCodeHost(runner.model);
  return {
    runner, model: runner.model, repository: { url: REPO_URL }, unregistered: { url: OTHER_URL }, scope: SCOPE, project: "unit-project",
    changeRequest: () => {
      const revision = runner.model.commit("rovara/feature", { "src/a.ts": "export const a = 1;\n" });
      const { cr } = runner.model.reconcile({ sourceBranch: "rovara/feature", targetBranch: "main", title: "t" });
      void host;
      return { ref: { repository: { url: REPO_URL }, id: cr.id, url: runner.model.crUrl(cr.id) }, revision };
    },
    finishRun: (runId, conclusion, log) => runner.finish(runId, conclusion, log),
  };
}

export const fakeCheckRunnerWorld = (): CheckRunnerWorld => checkRunnerWorldFor(new FakeCheckRunner(newModel()));

export function trackerWorldFor(tracker: FakeTracker): TrackerWorld {
  return {
    tracker, scope: SCOPE, forbiddenStatus: "done",
    addItem: (id, input) => { tracker.addItem(id, input); },
    statusOf: (id) => tracker.items.get(id)?.status,
    commentsOf: (id) => tracker.writes.filter((write) => write.kind === "comment" && write.item === id).map((write) => write.value),
    signedDelivery: (event) => fakeTrackerDelivery(event.kind === "assigned" ? { delivery: "t-1", event: "assigned", item: event.item } : { delivery: "t-2", event: "labelled", item: event.item, label: event.label }),
    forgedDelivery: () => ({ ...fakeTrackerDelivery({ delivery: "t-3", event: "assigned", item: "ENG-1" }), headers: { "x-fake-signature": `sha256=${"0".repeat(64)}` } }),
  };
}

export const fakeTrackerWorld = (): TrackerWorld => trackerWorldFor(new FakeTracker({ allowedStatuses: ["open", "in_progress", "in_review"] }));
