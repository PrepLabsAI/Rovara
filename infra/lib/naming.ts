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
  readonly workspaceKeyAlias: string;
  readonly alertsTopicName: string;
  alarmName(suffix: string): string;
  readonly connectorSecretPrefix: string;
  readonly metricsNamespace: string;
  /** The value of the resource `Environment` tag used by the foundation stack. */
  readonly environmentTagValue: string;
  readonly taskFamily: string;
  /** Prefix for the ECR pull-through cache rule, at most 27 characters. */
  readonly pullThroughPrefix: string;
  /** The role CloudFormation assumes to deploy this environment's stacks. */
  readonly cloudFormationRoleName: string;
  /** The role an operator assumes to run `agentx` against this environment. */
  readonly operatorRoleName: string;
}

/** The deployment that predates named environments has no access or identity stack. */
const NO_NAMED_ENVIRONMENTS_MESSAGE = "the access stack exists only for named environments";

/** The legacy deployment predates the identity stack; it has no fixed name for it. */
export const LEGACY_STACK_NAMES: Record<Exclude<StackPart, "identity" | "access">, string> = {
  foundation: "AgentXProductionFoundation",
  runtime: "AgentXProductionRuntime",
  "control-plane": "AgentXControlPlane",
  slack: "AgentXSlackOrchestrator",
};

/** Today's fixed names. The deployment that predates environments keeps them forever. */
export function legacyNaming(): AgentXNaming {
  return {
    env: undefined,
    stackName: (part) => {
      if (part === "identity") throw new Error("the legacy deployment has no identity stack");
      if (part === "access") throw new Error(NO_NAMED_ENVIRONMENTS_MESSAGE);
      return LEGACY_STACK_NAMES[part];
    },
    workerSecurityGroupName: "agentx-production-workers",
    apiName: "agentx-control-plane",
    resourcePrefix: "agentx-production",
    runtimeName: "agentx_production_worker",
    capacityProviderName: "agentx_production_capacity_v3",
    workspaceKeyAlias: "alias/agentx/production-workspaces",
    alertsTopicName: "AgentXOperatorAlerts",
    alarmName: (suffix) => `AgentX${suffix}`,
    connectorSecretPrefix: "agentx/connectors/",
    metricsNamespace: "AgentX",
    environmentTagValue: "production",
    taskFamily: "agentx-slack-orchestrator",
    // Getters, not eagerly computed values: legacy synthesis never reads them, so a getter throws
    // only if something actually tries to.
    get pullThroughPrefix(): string {
      throw new Error(NO_NAMED_ENVIRONMENTS_MESSAGE);
    },
    get cloudFormationRoleName(): string {
      throw new Error(NO_NAMED_ENVIRONMENTS_MESSAGE);
    },
    get operatorRoleName(): string {
      throw new Error(NO_NAMED_ENVIRONMENTS_MESSAGE);
    },
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
    workspaceKeyAlias: `alias/agentx/${name}/workspaces`,
    alertsTopicName: `agentx-${name}-alerts`,
    alarmName: (suffix) => `agentx-${name}-${suffix}`,
    connectorSecretPrefix: environmentConnectorSecretPrefix(name),
    metricsNamespace: `AgentX/${name}`,
    environmentTagValue: name,
    taskFamily: `agentx-${name}-slack-orchestrator`,
    pullThroughPrefix: `agentx-${name}`,
    cloudFormationRoleName: `agentx-${name}-cloudformation`,
    operatorRoleName: `agentx-${name}-operator`,
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
