// Port lane L2: the Linear tracker as a plug-in module. What Linear is asked (read an issue, write a comment, the hook's signing secret) is given by
// the install as `LinearTrackerAccess`; whatever it does not give, the adapter does not do.
import { z } from "zod";
import type { PluginContext, PluginModule } from "@agentx/contracts";
import { readPluginSettings } from "../../module-support.js";
import { linearTracker, LINEAR_TRACKER_KIND, type LinearTrackerAccess } from "./index.js";

export interface LinearTrackerPluginOptions {
  createAccess(context: PluginContext): LinearTrackerAccess | Promise<LinearTrackerAccess>;
}

export function linearTrackerPlugin(options: LinearTrackerPluginOptions): PluginModule<"tracker"> {
  return {
    point: "tracker",
    name: LINEAR_TRACKER_KIND,
    async create(context) {
      readPluginSettings(z.object({}).strict(), context.settings, `tracker/${LINEAR_TRACKER_KIND}`);
      return linearTracker(await options.createAccess(context));
    },
  };
}
