// SWE-bench / eval-batch admin and Slack route helpers (extracted from aws/broker.ts).
import { agentXError, modelKey, type SlackChannelBinding, SlackChannelIdSchema, SlackTeamIdSchema } from "@agentx/contracts";
import { type EvalBatchDependencies, withEvalBatches } from "./eval-batch.js";
import { approvedSelection, bindingOwnRow, getSlackBinding, requireAdministrator, requireLatestProject, resolveProjectModel } from "./broker-primitives.js";
import { batchResults, parseStartBody, requireBatchProject, showBatch, startBatch, stopBatchById } from "./eval-batch-admin.js";
import { deleteSwebenchChannel, getSwebenchChannel, putSwebenchChannel, type SwebenchSlackContext } from "./swebench.js";
import type { AwsBrokerDependencies } from "./broker-types.js";
import type { AuthenticatedIdentity } from "../auth.js";

/** Spec 043: the SWE-bench module's dependencies, from the broker's; spec 052 wires its batches into them. */
export function swebenchDependencies(dependencies: AwsBrokerDependencies): EvalBatchDependencies {
  const swebench = dependencies.swebench;
  if (swebench === undefined) throw agentXError("NOT_FOUND", "SWE-bench runs are not available in this deployment");
  return withEvalBatches({
    documentClient: dependencies.documentClient,
    s3: dependencies.s3,
    tableName: dependencies.tableName,
    artifactBucketName: dependencies.artifactBucketName,
    callbackSigningKey: dependencies.callbackSigningKey,
    ...swebench,
  });
}

/** The thread, requester and project model a SWE-bench run takes from the Slack service identity. */
export function swebenchSlackContext(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity): SwebenchSlackContext {
  const slack = identity.slack;
  if (!slack) throw agentXError("FORBIDDEN", "Slack thread context is required");
  return { thread: slack.thread, requester: slack.requester, ...swebenchProjectContext(dependencies, slack.binding) };
}

/** The project and its approved models, for a run or batch whose thread and requester the caller supplies. */
export function swebenchProjectContext(dependencies: AwsBrokerDependencies, binding: SlackChannelBinding): Pick<SwebenchSlackContext, "projectName" | "projectModel"> {
  const projectName = binding.projectName;
  return {
    projectName,
    projectModel: async (requested) => {
      const project = bindingOwnRow(binding, await requireLatestProject(dependencies, projectName));
      const policy = project.definition.models;
      if (requested !== undefined) {
        const approved = policy?.approved.find((candidate) => modelKey(candidate) === modelKey(requested));
        if (!approved) throw agentXError("CONFIG_INVALID", `model ${requested.provider}/${requested.modelId} is not approved for this project`);
        return approvedSelection(approved);
      }
      return (await resolveProjectModel(dependencies, project)).model;
    },
  };
}

/** Spec 052 FR-001: an administrator of the channel's project starts a batch from a file. */
export async function routeStartEvalBatch(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, value: unknown): Promise<unknown> {
  const body = parseStartBody(value);
  const binding = await getSlackBinding(dependencies, body.teamId, body.channelId);
  if (!binding) throw agentXError("NOT_FOUND", "Slack channel binding not found; bind the channel to a project first");
  await requireAdministrator(dependencies, identity, binding.projectName);
  return startBatch(swebenchDependencies(dependencies), swebenchProjectContext(dependencies, binding), body);
}

/** Spec 052 FR-009, FR-010: show, stop or read the results of a batch, for an administrator of its channel's project. */
export async function routeEvalBatch(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, batchId: string, action: "show" | "stop" | "results"): Promise<unknown> {
  // The admin claim first, so a non-administrator learns nothing about which batch IDs exist.
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  const swebench = swebenchDependencies(dependencies);
  // The project stored on the batch, not the channel's current binding: a rebound channel does not hand over old batches.
  await requireAdministrator(dependencies, identity, await requireBatchProject(swebench, batchId));
  if (action === "stop") return stopBatchById(swebench, batchId);
  return action === "results" ? batchResults(swebench, batchId) : showBatch(swebench, batchId);
}

/** Spec 043 FR-002: an administrator of the channel's project enables, reads or disables SWE-bench runs there. */
export async function routeSwebenchChannel(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  method: "PUT" | "DELETE" | "GET",
  teamIdValue: string,
  channelIdValue: string,
  body: unknown,
): Promise<unknown> {
  const teamId = SlackTeamIdSchema.parse(decodeURIComponent(teamIdValue));
  const channelId = SlackChannelIdSchema.parse(decodeURIComponent(channelIdValue));
  const binding = await getSlackBinding(dependencies, teamId, channelId);
  if (!binding) throw agentXError("NOT_FOUND", "Slack channel binding not found; bind the channel to a project first");
  await requireAdministrator(dependencies, identity, binding.projectName);
  const swebench = swebenchDependencies(dependencies);
  if (method === "PUT") return { channel: await putSwebenchChannel(swebench, teamId, channelId, body), projectName: binding.projectName };
  if (method === "DELETE") return deleteSwebenchChannel(swebench, teamId, channelId);
  const channel = await getSwebenchChannel(swebench, teamId, channelId);
  if (!channel) throw agentXError("NOT_FOUND", "SWE-bench runs are not enabled in this channel");
  return { channel, projectName: binding.projectName };
}
