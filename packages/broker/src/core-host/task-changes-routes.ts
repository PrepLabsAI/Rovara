// RD-2.0 stub of the task page's changes read (RD-2b2 fills it). Until then (it takes the `TaskScreenContext` of task-screen-routes.ts once it reads anything) the read answers the fixed `ROUTE_NOT_SERVED` refusal and reads nothing (fail closed). The response schema is `TaskChangesReadSchema` in packages/code-api.
import { ROUTE_NOT_SERVED_MESSAGE, agentXError } from "@agentx/contracts";
import type { BrokerResponse } from "../handler.js";

export function readTaskChanges(): Promise<BrokerResponse> {
  return Promise.reject(agentXError("ROUTE_NOT_SERVED", ROUTE_NOT_SERVED_MESSAGE));
}
