import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, StartDeveloperTaskRequestSchema, agentXError } from "@agentx/contracts";
import type { AdaptedHttpRequest } from "./lambda.js";
import { readTaskStamp, entryOwner } from "./engine-boundary.js";
import { engineStampKey } from "../core-host/engine-stamp.js";
import { readStartRequest, startReadNotFound, startReadUnavailable } from "../core/task-flow/start-request-read.js";
import { resolveTaskPeopleReadAccess } from "../developer/task-people.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./developer-routes.js";
import type { CheckTaskPerson } from "../developer/task-people.js";
import type { ServerReadContext } from "./server-read-context.js";

export async function taskStartRequestRoute(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL, caller: DeveloperCaller,
  context: ServerReadContext, company: () => Promise<string>, personProof: CheckTaskPerson) {
  const rawId = /^\/v1\/dev\/tasks\/start-requests\/([^/]+)$/.exec(url.pathname)?.[1];
  const id = StartDeveloperTaskRequestSchema.shape.requestId.safeParse(rawId);
  if (!id.success || rawId?.includes("%") || url.search !== "" || (request.body !== undefined && request.body !== "")) throw agentXError("CONFIG_INVALID", "That start request is invalid.");
  const get = async (key: { pk: string; sk: string }) => {
    const response = await context.client.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: unknown };
    if (response === null || typeof response !== "object" || Array.isArray(response)) throw startReadUnavailable();
    return response.Item;
  };
  try {
    return await readStartRequest({ get, company, check: () => context.check(), now: () => deps.now(),
      coreStamp: async (taskId, companyId) => {
        // readTaskStamp's existing payload parser plus the persisted stamp's key/company provenance.
        let raw: unknown;
        const stamp = await readTaskStamp({ tableName: deps.tableName, documentClient: { send: async command => {
          const response = await context.client.send(command) as { Item?: unknown }; raw = response.Item; return response;
        } } }, taskId);
        const item = raw as Record<string, unknown> | undefined;
        const key = engineStampKey(taskId);
        if (stamp === undefined || entryOwner(stamp, "flow") !== "core" || item?.pk !== key.pk || item.sk !== key.sk || item.entityType !== "TASK_ENGINE"
          || item.taskId !== taskId || item.orgId !== companyId || !Number.isFinite(Date.parse(stamp.stampedAt))) throw startReadUnavailable();
        return raw;
      },
      authority: task => resolveTaskPeopleReadAccess({ get, checkTaskPerson: personProof }, task, caller.developerId),
    }, caller.developerId, id.data);
  } catch (error) {
    context.check();
    if (error instanceof AgentXError && (error.code === "TASK_NOT_FOUND" || error.code === "TASK_ACCESS_DENIED")) throw startReadNotFound();
    throw startReadUnavailable();
  }
}
