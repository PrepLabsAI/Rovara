// The Jira tracker as a plug-in module. The install gives the owner's site, email and a way to read the API token (a secret, read when it is used); the settings block holds names, never a secret.
import { z } from "zod";
import type { PluginContext, PluginModule } from "@agentx/contracts";
import { readPluginSettings } from "../../module-support.js";
import { JIRA_TRACKER_KIND, jiraTracker, type JiraApiOptions } from "./index.js";

export interface JiraTrackerPluginOptions {
  createAccess(context: PluginContext): JiraApiOptions | Promise<JiraApiOptions>;
}

export function jiraTrackerPlugin(options: JiraTrackerPluginOptions): PluginModule<"tracker"> {
  return {
    point: "tracker",
    name: JIRA_TRACKER_KIND,
    async create(context) {
      readPluginSettings(z.object({}).strict(), context.settings, `tracker/${JIRA_TRACKER_KIND}`);
      return jiraTracker(await options.createAccess(context));
    },
  };
}
