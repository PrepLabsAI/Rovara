// Port lane L2: the fake code host, check runner and tracker as plug-in modules, for tests and for a developer running with no outside system.
// They share one `FakeHostModel` (the host's repository, change requests and checks).
import type { PluginModule } from "@agentx/contracts";
import { FakeCheckRunner, FAKE_RUNNER_KIND } from "./check-runner.js";
import { FakeCodeHost, FAKE_HOST_KIND } from "./code-host.js";
import type { FakeHostModel } from "./model.js";
import { FakeTracker, FAKE_TRACKER_KIND, type FakeTrackerOptions } from "./tracker.js";

export interface FakePlugins {
  codeHost: PluginModule<"code-host">;
  checkRunner: PluginModule<"check-runner">;
  tracker: PluginModule<"tracker">;
}

export function fakePlugins(model: FakeHostModel, trackerOptions: FakeTrackerOptions = {}): FakePlugins {
  return {
    codeHost: { point: "code-host", name: FAKE_HOST_KIND, create: () => new FakeCodeHost(model) },
    checkRunner: { point: "check-runner", name: FAKE_RUNNER_KIND, create: () => ({ kind: FAKE_RUNNER_KIND, create: () => new FakeCheckRunner(model) }) },
    tracker: { point: "tracker", name: FAKE_TRACKER_KIND, create: () => new FakeTracker(trackerOptions) },
  };
}
