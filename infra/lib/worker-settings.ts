import { CfnCondition, Fn } from "aws-cdk-lib";
import { openRouterParameters, openRouterRoutingParameter } from "./openrouter.js";
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
    const modelProvider = new CfnParameter(this, "ModelProvider", {
      type: "String",
      default: "amazon-bedrock",
      description: "pi model provider identifier",
    });
    const modelId = new CfnParameter(this, "ModelId", {
      type: "String",
      description: "pi model identifier available in the deployment region",
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
    const { secretArn } = openRouterParameters(this);
    const providers = openRouterRoutingParameter(this);
    const hasSecret = new CfnCondition(this, "HasOpenRouterSecret", { expression: Fn.conditionNot(Fn.conditionEquals(secretArn.valueAsString, "")) });
    const hasProviders = new CfnCondition(this, "HasOpenRouterProviders", { expression: Fn.conditionNot(Fn.conditionEquals(providers.valueAsString, "")) });
    const workerSettings: Array<[string, keyof typeof WORKER_SETTING_PARAMETERS, string]> = [
      ["WorkerOpenRouterSecretParameter", "openRouterSecretArn", Fn.conditionIf(hasSecret.logicalId, secretArn.valueAsString, "none").toString()],
      ["WorkerOpenRouterProvidersParameter", "openRouterProviders", Fn.conditionIf(hasProviders.logicalId, providers.valueAsString, "none").toString()],
      ["WorkerModelProviderParameter", "modelProvider", modelProvider.valueAsString],
      ["WorkerModelIdParameter", "modelId", modelId.valueAsString],
      ["WorkerPromptCacheRetentionParameter", "promptCacheRetention", promptCacheRetention.valueAsString],
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
