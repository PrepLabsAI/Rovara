import { CfnCondition, Fn } from "aws-cdk-lib";
import { providerKeyParameters } from "./model-keys.js";
import { openRouterRoutingParameter } from "./openrouter.js";
import { CfnParameter, Stack, type StackProps, aws_ssm as ssm } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { WORKER_SETTING_PARAMETERS } from "@agentx/contracts";
import { type AgentXNaming, legacyNaming } from "./naming.js";

export interface WorkerSettingsStackProps extends StackProps {
  naming?: AgentXNaming;
}

/**
 * What a release publishes for EC2 workers (#117): the worker image and model settings, as SSM
 * parameters the session provisioner reads when it boots a worker. This stack used to deploy the
 * retired runtime too; its stack and parameter names remain stable.
 */
export class WorkerSettingsStack extends Stack {
  constructor(scope: Construct, id: string, props: WorkerSettingsStackProps = {}) {
    super(scope, id, props);
    const naming = props.naming ?? legacyNaming();

    const imageUri = new CfnParameter(this, "WorkerImageUri", {
      type: "String",
      allowedPattern: "^.+@sha256:[a-f0-9]{64}$",
      description: "Immutable private ECR linux/arm64 worker image URI",
    });
    // Optional: a release before the web/API runtime has no executor, and an environment that never deploys one keeps "none".
    const executorImageUri = new CfnParameter(this, "ExecutorImageUri", {
      type: "String",
      default: "none",
      allowedPattern: "^(none|.+@sha256:[a-f0-9]{64})$",
      description: "Immutable private ECR linux/arm64 browser executor image URI, or none",
    });
    const modelProvider = new CfnParameter(this, "ModelProvider", {
      type: "String",
      default: "amazon-bedrock",
      description: "pi model provider identifier",
    });
    const modelId = new CfnParameter(this, "ModelId", {
      type: "String",
      description: "pi model identifier available in the deployment region",
    });
    // Task 4.10: the AI navigation model the installation chose, a setting beside the coding model (not a boot variable: the worker searches the eligible models for the revision
    // an admission names). `agentx config set models.e2eAgent` changes it; the broker reads it from SSM, the worker never does.
    const e2eAgentModelId = new CfnParameter(this, "E2eAgentModelId", {
      type: "String",
      default: "default",
      allowedPattern: "^(default|[A-Za-z0-9][A-Za-z0-9._:/-]{0,199})$",
      description: "AI navigation model for browser checks: default (Rovara's recommendation) or an eligible model id",
    });
    const promptCacheRetention = new CfnParameter(this, "PromptCacheRetention", {
      type: "String",
      default: "long",
      allowedValues: ["short", "long"],
      description: "Bedrock prompt-cache retention mode used by pi",
    });

    new ssm.StringParameter(this, "WorkerImageParameter", {
      parameterName: naming.ec2.workerImageParameterName,
      stringValue: imageUri.valueAsString,
      description: "AgentX worker image URI pinned by digest, for EC2 workers",
    });
    const keys = providerKeyParameters(this);
    const providers = openRouterRoutingParameter(this);
    const hasSecret = new CfnCondition(this, "HasOpenRouterSecret", { expression: Fn.conditionNot(Fn.conditionEquals(keys.openrouter.valueAsString, "")) });
    const hasAnthropicSecret = new CfnCondition(this, "HasAnthropicSecret", { expression: Fn.conditionNot(Fn.conditionEquals(keys.anthropic.valueAsString, "")) });
    const hasOpenAISecret = new CfnCondition(this, "HasOpenAISecret", { expression: Fn.conditionNot(Fn.conditionEquals(keys.openai.valueAsString, "")) });
    const hasProviders = new CfnCondition(this, "HasOpenRouterProviders", { expression: Fn.conditionNot(Fn.conditionEquals(providers.valueAsString, "")) });
    const workerSettings: Array<[string, keyof typeof WORKER_SETTING_PARAMETERS, string]> = [
      ["WorkerOpenRouterSecretParameter", "openRouterSecretArn", Fn.conditionIf(hasSecret.logicalId, keys.openrouter.valueAsString, "none").toString()],
      ["WorkerAnthropicSecretParameter", "anthropicSecretArn", Fn.conditionIf(hasAnthropicSecret.logicalId, keys.anthropic.valueAsString, "none").toString()],
      ["WorkerOpenAISecretParameter", "openaiSecretArn", Fn.conditionIf(hasOpenAISecret.logicalId, keys.openai.valueAsString, "none").toString()],
      ["WorkerOpenRouterProvidersParameter", "openRouterProviders", Fn.conditionIf(hasProviders.logicalId, providers.valueAsString, "none").toString()],
      ["WorkerExecutorImageParameter", "executorImage", executorImageUri.valueAsString],
      ["WorkerModelProviderParameter", "modelProvider", modelProvider.valueAsString],
      ["WorkerModelIdParameter", "modelId", modelId.valueAsString],
      ["WorkerPromptCacheRetentionParameter", "promptCacheRetention", promptCacheRetention.valueAsString],
      ["WorkerE2eAgentModelParameter", "e2eAgentModel", e2eAgentModelId.valueAsString],
    ];
    for (const [id, setting, value] of workerSettings) {
      new ssm.StringParameter(this, id, {
        parameterName: `${naming.ec2.workerSettingsPrefix}${WORKER_SETTING_PARAMETERS[setting]}`,
        stringValue: value,
        description: `AgentX worker ${setting} for EC2 workers`,
      });
    }
  }
}
