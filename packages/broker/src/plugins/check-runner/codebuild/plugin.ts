// Port lane L2: AWS CodeBuild as an optional check runner plug-in. AWS is reached through `CodeBuildGateway` (`broker/src/codebuild.ts`); the install
// says how to build one. A runner serves only the repositories the caller's project registered.
import { z } from "zod";
import { PluginRegistryError, type PluginContext, type PluginModule } from "@agentx/contracts";
import type { CodeBuildGateway } from "../../../codebuild.js";
import { readPluginSettings } from "../../module-support.js";
import { codeBuildCheckRunner, CODEBUILD_RUNNER_KIND } from "./index.js";

export interface CodeBuildPluginOptions {
  createGateway(context: PluginContext): CodeBuildGateway | Promise<CodeBuildGateway>;
}

export function codeBuildPlugin(options: CodeBuildPluginOptions): PluginModule<"check-runner"> {
  return {
    point: "check-runner",
    name: CODEBUILD_RUNNER_KIND,
    async create(context) {
      readPluginSettings(z.object({}).strict(), context.settings, `check-runner/${CODEBUILD_RUNNER_KIND}`);
      const gateway = await options.createGateway(context);
      if (typeof gateway.start !== "function" || typeof gateway.status !== "function") throw new PluginRegistryError("create_failed", "the CodeBuild gateway lacks methods the adapter needs");
      return { kind: CODEBUILD_RUNNER_KIND, create: (runnerContext) => codeBuildCheckRunner({ gateway, allowedRepositories: runnerContext.allowedRepositories }) };
    },
  };
}
