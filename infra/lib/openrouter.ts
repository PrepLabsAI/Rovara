import { CfnCondition, CfnParameter, Fn, Stack, aws_iam as iam } from "aws-cdk-lib";
import type { Construct } from "constructs";

/** Only a reference is deployed. The API key is fetched into process memory by the caller. */
export function openRouterParameters(scope: Construct) {
  const stack = Stack.of(scope);
  const secretArn = new CfnParameter(stack, "OpenRouterSecretArn", {
    type: "String", default: "",
    allowedPattern: "^$|^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$",
    description: "Optional Secrets Manager ARN containing the raw OpenRouter API key",
  });
  return { secretArn };
}

export function grantOpenRouterSecret(scope: Construct, roleNames: string[]): void {
  const { secretArn } = openRouterParameters(scope);
  const enabled = new CfnCondition(scope, "OpenRouterEnabled", { expression: Fn.conditionNot(Fn.conditionEquals(secretArn.valueAsString, "")) });
  const policy = new iam.CfnPolicy(scope, "OpenRouterSecretRead", {
    policyName: "OpenRouterSecretRead", roles: roleNames,
    policyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: secretArn.valueAsString }] },
  });
  policy.cfnOptions.condition = enabled;
}

export function openRouterRoutingParameter(scope: Construct): CfnParameter {
  return new CfnParameter(scope, "OpenRouterProviders", {
    type: "String", default: "",
    allowedPattern: "^$|^[a-z0-9][a-z0-9_/-]{0,79}(,[a-z0-9][a-z0-9_/-]{0,79})*$",
    description: "Optional comma-separated OpenRouter provider allowlist; fallbacks are disabled",
  });
}
