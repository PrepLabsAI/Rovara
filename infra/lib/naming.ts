import type { App } from "aws-cdk-lib";
import {
  EnvironmentNameSchema,
  environmentConnectorSecretPrefix,
  environmentStackName,
  type StackPart,
} from "@agentx/contracts";

export interface AgentXNaming {
  /** undefined for legacy naming. */
  readonly env: string | undefined;
  stackName(part: StackPart): string;
  readonly workerSecurityGroupName: string;
  readonly apiName: string;
  /** Prefix of the foundation's `Name` tags. */
  readonly resourcePrefix: string;
  readonly runtimeName: string;
  readonly capacityProviderName: string;
  readonly alertsTopicName: string;
  alarmName(suffix: string): string;
  readonly connectorSecretPrefix: string;
  readonly metricsNamespace: string;
  /** The value of the resource `Environment` tag used by the foundation stack. */
  readonly environmentTagValue: string;
}

export const LEGACY_STACK_NAMES: Record<StackPart, string> = {
  foundation: "AgentXProductionFoundation",
  runtime: "AgentXProductionRuntime",
  "control-plane": "AgentXControlPlane",
  slack: "AgentXSlackOrchestrator",
};

/** Today's fixed names. The deployment that predates environments keeps them forever. */
export function legacyNaming(): AgentXNaming {
  return {
    env: undefined,
    stackName: (part) => LEGACY_STACK_NAMES[part],
    workerSecurityGroupName: "agentx-production-workers",
    apiName: "agentx-control-plane",
    resourcePrefix: "agentx-production",
    runtimeName: "agentx_production_worker",
    capacityProviderName: "agentx_production_capacity_v3",
    alertsTopicName: "AgentXOperatorAlerts",
    alarmName: (suffix) => `AgentX${suffix}`,
    connectorSecretPrefix: "agentx/connectors/",
    metricsNamespace: "AgentX",
    environmentTagValue: "production",
  };
}

export function environmentNaming(env: string): AgentXNaming {
  const name = EnvironmentNameSchema.parse(env);
  return {
    env: name,
    stackName: (part) => environmentStackName(name, part),
    workerSecurityGroupName: `agentx-${name}-workers`,
    apiName: `agentx-${name}-control-plane`,
    resourcePrefix: `agentx-${name}`,
    // AgentCore runtime and capacity-provider names allow letters, digits and underscores only.
    runtimeName: `agentx_${name.replaceAll("-", "_")}_worker`,
    capacityProviderName: `agentx_${name.replaceAll("-", "_")}_capacity`,
    alertsTopicName: `agentx-${name}-alerts`,
    alarmName: (suffix) => `agentx-${name}-${suffix}`,
    connectorSecretPrefix: environmentConnectorSecretPrefix(name),
    metricsNamespace: `AgentX/${name}`,
    environmentTagValue: name,
  };
}

export function namingFromContext(app: App): AgentXNaming {
  const env = app.node.tryGetContext("agentxEnv") as unknown;
  if (env === undefined) return legacyNaming();
  if (typeof env !== "string") throw new Error("invalid environment name: agentxEnv context must be a string");
  const parsed = EnvironmentNameSchema.safeParse(env);
  if (!parsed.success) throw new Error(`invalid environment name ${JSON.stringify(env)}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return environmentNaming(parsed.data);
}
