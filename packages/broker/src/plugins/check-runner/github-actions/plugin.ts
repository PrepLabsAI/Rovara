// Port lane L2: the GitHub Actions check runner as a plug-in module (see `code-host/github/plugin.ts`: the same GitHub client).
import { z } from "zod";
import { PluginRegistryError, type PluginContext, type PluginModule } from "@agentx/contracts";
import { readPluginSettings } from "../../module-support.js";
import type { GitHubActionsProvider } from "../../code-host/github/provider.js";
import { githubActionsCheckRunner, GITHUB_ACTIONS_RUNNER_KIND } from "./index.js";

export interface GitHubActionsPluginOptions {
  createProvider(context: PluginContext): GitHubActionsProvider | Promise<GitHubActionsProvider>;
}

export function githubActionsPlugin(options: GitHubActionsPluginOptions): PluginModule<"check-runner"> {
  return {
    point: "check-runner",
    name: GITHUB_ACTIONS_RUNNER_KIND,
    async create(context) {
      readPluginSettings(z.object({}).strict(), context.settings, `check-runner/${GITHUB_ACTIONS_RUNNER_KIND}`);
      const provider = await options.createProvider(context);
      if (typeof provider.getPullRequestStatus !== "function" || typeof provider.getJobLogTail !== "function") throw new PluginRegistryError("create_failed", "the GitHub client lacks methods the adapter needs");
      return { kind: GITHUB_ACTIONS_RUNNER_KIND, create: () => githubActionsCheckRunner(provider) };
    },
  };
}
