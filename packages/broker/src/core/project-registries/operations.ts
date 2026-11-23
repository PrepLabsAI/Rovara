// The reads and the one counter the registry credential route asks of the stored records (the same shape as the saved-image routes' `saved-env-operations.ts`): the operation and its workspace in THIS
// company's keys, the project revision the workspace is pinned to, and a count on the operation, added to with a condition so two requests at once cannot both take the last slot.
import { agentXError, change, when, type DocumentStore } from "@agentx/contracts";
import type { RepositoryGrantService } from "../../repository-access.js";
import type { BrokerRequest, BrokerResponse } from "../../handler.js";
import type { ProjectSource, TaskFlowDeps } from "../task-flow/deps.js";
import { locateWorkspace } from "../task-flow/workspace-location.js";
import { REGISTRY_REQUESTS_MAX_PER_OPERATION, exchangeRegistryCredentialCore, type RegistryExchangeContext } from "./exchange.js";
import type { ProjectRegistriesInstall } from "./prepare.js";

const word = (value: unknown): string => (typeof value === "string" ? value : "");
const number = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) ? value : undefined);

export function registryExchangeContext(input: {
  companyId: string; store: Pick<DocumentStore, "get" | "update">; projects: ProjectSource; install: ProjectRegistriesInstall | undefined;
  inspectGrant: RegistryExchangeContext["inspectGrant"]; audit: RegistryExchangeContext["audit"]; now?: (() => Date) | undefined; log?: RegistryExchangeContext["log"];
}): RegistryExchangeContext {
  const { companyId, store } = input;
  return {
    companyId,
    install: input.install,
    audit: input.audit,
    inspectGrant: input.inspectGrant,
    async readOperation(workspaceId, operationId) {
      const location = await locateWorkspace({ store, companyId }, workspaceId);
      if (location === undefined) throw agentXError("NOT_FOUND", "no such operation");
      const workspace = location.workspace;
      const operation = await store.get(location.operationKey(operationId));
      if (operation === undefined || (operation["companyId"] !== undefined && operation["companyId"] !== companyId)) throw agentXError("NOT_FOUND", "no such operation");
      const active = workspace["activeOperationId"];
      const requester = operation["requester"];
      const requesterId = typeof requester === "object" && requester !== null && typeof (requester as { personId?: unknown }).personId === "string" ? (requester as { personId: string }).personId : undefined;
      return {
        ...(requesterId === undefined ? {} : { requesterId }),
        kind: word(operation["kind"]), status: word(operation["status"]), fence: number(operation["fence"]),
        projectName: word(workspace["projectName"]), projectRevision: number(workspace["projectRevision"]),
        workspace: { status: word(workspace["status"]), activeOperationId: typeof active === "string" ? active : null, fence: number(workspace["fence"]) },
      };
    },
    async readProject(project, revision) {
      const found = await input.projects.revision(project, revision);
      return found === undefined ? undefined : { registries: found.definition.registries ?? [], allowedDomains: found.definition.network?.allowedDomains ?? [] };
    },
    async countRequest(workspaceId, operationId) {
      const location = await locateWorkspace({ store, companyId }, workspaceId);
      if (location === undefined) return false;
      const written = await store.update({
        key: location.operationKey(operationId), ops: [change.add("registryCredentialCount", 1)],
        condition: when.and(when.present(), when.or(when.notExists("registryCredentialCount"), when.lt("registryCredentialCount", REGISTRY_REQUESTS_MAX_PER_OPERATION))),
      });
      return written.applied;
    },
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.log === undefined ? {} : { log: input.log }),
  };
}

/**
 * The route's whole answer: the exchange over this company's flow, the operation's grant as the proof, and no cache on the answer (it holds a token). The body is read by the caller.
 */
export async function registryCredentialRoute(flow: TaskFlowDeps, grants: Pick<RepositoryGrantService, "inspect">, request: BrokerRequest, workspaceId: string, operationId: string, body: unknown): Promise<BrokerResponse> {
  const context = registryExchangeContext({ companyId: flow.companyId, store: flow.store, projects: flow.projects, install: flow.projectRegistries, inspectGrant: (grant) => grants.inspect(grant), audit: flow.audit, now: flow.now, log: flow.log });
  const answer = await exchangeRegistryCredentialCore(context, { grant: request.headers["x-agentx-repository-grant"], workspaceId, operationId, body });
  return { statusCode: 200, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(answer) };
}
