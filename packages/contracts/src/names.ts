import { z } from "zod";
/** The AgentX name pattern, shared by modules that cannot import each other. */
export const AGENTX_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

export const AgentXNameSchema = z.string().regex(AGENTX_NAME_PATTERN);
