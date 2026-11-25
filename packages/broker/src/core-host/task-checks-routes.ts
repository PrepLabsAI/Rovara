// RD-2.0 stub of the task page's checks read (RD-2b1 fills it). Until then (it takes the `TaskScreenContext` of task-screen-routes.ts once it reads anything) the read answers the fixed `ROUTE_NOT_SERVED` refusal and reads nothing (fail closed). The response schema is `TaskChecksReadSchema` in packages/code-api.
import { ROUTE_NOT_SERVED_MESSAGE, agentXError } from "@agentx/contracts";
import type { BrokerResponse } from "../handler.js";

export function readTaskChecks(): Promise<BrokerResponse> {
  return Promise.reject(agentXError("ROUTE_NOT_SERVED", ROUTE_NOT_SERVED_MESSAGE));
}
