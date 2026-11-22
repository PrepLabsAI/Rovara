import { agentXError } from "@agentx/contracts";

export const MODEL_ACCESS_INVALID = "invalid or expired model access";
export const invalidModelAccess = () => agentXError("AUTH_REQUIRED", MODEL_ACCESS_INVALID);
