import type { SkillIdSchema, SpendRequestIdSchema, ApprovalIdSchema, ModelSourceIdSchema, AgentOwnerSchema, AgentPrincipalSchema, AutonomySchema, BaseRefSchema } from "./agent.js";
import { type IdPrefix, PREFIXED_ID_BODY_LENGTH, prefixedIdPattern } from "./agent.js";
import { randomBytes } from "node:crypto";
import { z } from "zod";

const MIN_RANDOM_BYTES = 16;

/**
 * A server-generated id: the prefix and 20 base36 characters from at least 16 random bytes, reduced modulo 36^20
 * the way org ids are. Ids are never taken from a request.
 */
export function newPrefixedId(prefix: IdPrefix, random: () => Uint8Array = () => randomBytes(32)): string {
  const bytes = random();
  if (bytes.length < MIN_RANDOM_BYTES) throw new Error(`an id needs at least ${MIN_RANDOM_BYTES} random bytes`);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return `${prefix}_${(value % 36n ** BigInt(PREFIXED_ID_BODY_LENGTH)).toString(36).padStart(PREFIXED_ID_BODY_LENGTH, "0")}`;
}

export const ConnectionIdSchema = z.string().regex(prefixedIdPattern("con"));

export type SkillId = z.infer<typeof SkillIdSchema>;

export type SpendRequestId = z.infer<typeof SpendRequestIdSchema>;

export type ApprovalId = z.infer<typeof ApprovalIdSchema>;

export type ConnectionId = z.infer<typeof ConnectionIdSchema>;

export type ModelSourceId = z.infer<typeof ModelSourceIdSchema>;

export type AgentOwner = z.infer<typeof AgentOwnerSchema>;

export type AgentPrincipal = z.infer<typeof AgentPrincipalSchema>;

export type Autonomy = z.infer<typeof AutonomySchema>;

export type BaseRef = z.infer<typeof BaseRefSchema>;

export { AGENT_NAME_MAX, AGENT_DESCRIPTION_MAX, BUILTIN_AGENT_IDS, type BuiltinAgentId, ROVARA_CODE_AGENT_ID, PREFIXED_ID_BODY_LENGTH, type IdPrefix, prefixedIdPattern, BuiltinAgentIdSchema, AgentIdSchema, SkillIdSchema, SpendRequestIdSchema, ApprovalIdSchema, ModelSourceIdSchema, type AgentId, isBuiltinAgentId, MemberOwnerSchema, ProjectOwnerSchema, AgentOwnerSchema, AgentPrincipalSchema, AGENT_ACCESS_LEVELS, AgentAccessLevelSchema, type AgentAccessLevel, atLeast, AutonomySchema, BaseRefSchema, principalKey, ModelListSchema } from "./agent.js";
