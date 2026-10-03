import { CfnParameter } from "aws-cdk-lib";
import type { Construct } from "constructs";

export function openRouterRoutingParameter(scope: Construct): CfnParameter {
  return new CfnParameter(scope, "OpenRouterProviders", {
    type: "String", default: "",
    allowedPattern: "^$|^[a-z0-9][a-z0-9_/-]{0,79}(,[a-z0-9][a-z0-9_/-]{0,79})*$",
    description: "Optional comma-separated OpenRouter provider allowlist; fallbacks are disabled",
  });
}
