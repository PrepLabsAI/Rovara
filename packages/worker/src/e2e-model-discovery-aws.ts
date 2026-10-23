import { BedrockClient, GetFoundationModelAvailabilityCommand, ListFoundationModelsCommand, ListInferenceProfilesCommand } from "@aws-sdk/client-bedrock";
import { ListServiceQuotasCommand, ServiceQuotasClient } from "@aws-sdk/client-service-quotas";
import type { BedrockDiscoveryClient, QuotaClient } from "@agentx/model-runtime/model-discovery";

/**
 * The worker's real transports for model discovery (M1.4 Task 4.10C): the read-only Bedrock control plane and Service Quotas, called with the worker's own instance role (the policy
 * `E2eModelDiscovery`). Only ids, statuses and counts leave these functions: no ARN of an account, no message text.
 */
export function awsBedrockDiscoveryClient(region: string): BedrockDiscoveryClient {
  const client = new BedrockClient({ region, maxAttempts: 2 });
  return {
    async listInferenceProfiles(page) {
      const response = await client.send(new ListInferenceProfilesCommand({ typeEquals: "SYSTEM_DEFINED", maxResults: 100, ...(page.nextToken === undefined ? {} : { nextToken: page.nextToken }) }));
      return {
        profiles: (response.inferenceProfileSummaries ?? []).flatMap((profile) => (profile.inferenceProfileId === undefined ? [] : [{
          id: profile.inferenceProfileId, status: profile.status ?? "UNKNOWN",
          // The foundation model behind each Region of the profile: the id after `foundation-model/` in its ARN.
          foundationModelIds: [...new Set((profile.models ?? []).flatMap((model) => { const id = model.modelArn?.split("foundation-model/")[1]; return id === undefined ? [] : [id]; }))],
        }])),
        nextToken: response.nextToken,
      };
    },
    async listFoundationModels() {
      const response = await client.send(new ListFoundationModelsCommand({}));
      return (response.modelSummaries ?? []).flatMap((model) => (model.modelId === undefined ? [] : [{ modelId: model.modelId, modelName: model.modelName ?? "", providerName: model.providerName ?? "" }]));
    },
    async getAvailability(foundationModelId) {
      const response = await client.send(new GetFoundationModelAvailabilityCommand({ modelId: foundationModelId }));
      return { agreement: response.agreementAvailability?.status ?? null, authorization: response.authorizationStatus ?? null };
    },
  };
}

export function awsQuotaClient(region: string): QuotaClient {
  const client = new ServiceQuotasClient({ region, maxAttempts: 2 });
  return {
    async list(page) {
      const response = await client.send(new ListServiceQuotasCommand({ ServiceCode: "bedrock", MaxResults: 100, ...(page.nextToken === undefined ? {} : { NextToken: page.nextToken }) }));
      return { quotas: (response.Quotas ?? []).flatMap((quota) => (quota.QuotaCode === undefined || quota.QuotaName === undefined || typeof quota.Value !== "number" ? [] : [{ code: quota.QuotaCode, name: quota.QuotaName, value: quota.Value }])), nextToken: response.NextToken };
    },
  };
}
