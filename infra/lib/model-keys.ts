import { CfnCondition, CfnParameter, Fn, Stack, aws_iam as iam } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { KEYED_MODEL_PROVIDERS, KEYED_PROVIDER_IDS, type KeyedModelProvider } from "@agentx/contracts";

/**
 * A keyed provider's optional secret ARN parameter (specs 032, 054). Only a reference is deployed;
 * the API key is fetched into process memory by the caller. One parameter per stack, however many
 * constructs ask for it.
 */
export function providerKeyParameter(scope: Construct, provider: KeyedModelProvider): CfnParameter {
  const stack = Stack.of(scope);
  const { stackParameter, label } = KEYED_MODEL_PROVIDERS[provider];
  const existing = stack.node.tryFindChild(stackParameter);
  if (existing instanceof CfnParameter) return existing;
  return new CfnParameter(stack, stackParameter, {
    type: "String", default: "",
    allowedPattern: "^$|^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$",
    description: `Optional Secrets Manager ARN containing the raw ${label} API key`,
  });
}

/** Every keyed provider's secret ARN parameter, by provider. */
export function providerKeyParameters(scope: Construct): Record<KeyedModelProvider, CfnParameter> {
  return Object.fromEntries(KEYED_PROVIDER_IDS.map((provider) => [provider, providerKeyParameter(scope, provider)])) as Record<KeyedModelProvider, CfnParameter>;
}

/** Lets the roles read each configured provider secret, and nothing when its ARN is empty. */
export function grantProviderKeySecrets(scope: Construct, roleNames: string[]): void {
  for (const provider of KEYED_PROVIDER_IDS) {
    const secretArn = providerKeyParameter(scope, provider);
    const prefix = KEYED_MODEL_PROVIDERS[provider].constructPrefix;
    const enabled = new CfnCondition(scope, `${prefix}Enabled`, { expression: Fn.conditionNot(Fn.conditionEquals(secretArn.valueAsString, "")) });
    const policy = new iam.CfnPolicy(scope, `${prefix}SecretRead`, {
      policyName: `${prefix}SecretRead`, roles: roleNames,
      policyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: secretArn.valueAsString }] },
    });
    policy.cfnOptions.condition = enabled;
  }
}
