import { z } from "zod";
import { AGENTX_NAME_PATTERN } from "./names.js";
import { ModelCompanySchema } from "./models.js";

export const AGENT_NAME_MAX = 60;

export const AGENT_DESCRIPTION_MAX = 500;

export const BUILTIN_AGENT_IDS = ["rovara-code", "ticket-triage", "root-cause-analyst", "code-reviewer", "deploy-reviewer", "service-reviewer"] as const;

export type BuiltinAgentId = (typeof BUILTIN_AGENT_IDS)[number];

export const ROVARA_CODE_AGENT_ID: BuiltinAgentId = "rovara-code";

export const PREFIXED_ID_BODY_LENGTH = 20;

export type IdPrefix = "agt" | "skl" | "spr" | "apr" | "src" | "con" | "chn" | "crn" | "ctr" | "ses" | "dvc" | "msg" | "stk";

export function prefixedIdPattern(prefix: IdPrefix): RegExp {
  return new RegExp(`^${prefix}_[0-9a-z]{${PREFIXED_ID_BODY_LENGTH}}$`);
}

export const BuiltinAgentIdSchema = z.enum(BUILTIN_AGENT_IDS);

export const AgentIdSchema = z.union([BuiltinAgentIdSchema, z.string().regex(prefixedIdPattern("agt"))]);

export const SkillIdSchema = z.string().regex(prefixedIdPattern("skl"));

export const SpendRequestIdSchema = z.string().regex(prefixedIdPattern("spr"));

export const ApprovalIdSchema = z.string().regex(prefixedIdPattern("apr"));

/** `rovara` is Rovara's own models and `personal-chatgpt` a member's ChatGPT plan; every other source is a company's own. */
export const ModelSourceIdSchema = z.union([z.literal("rovara"), z.literal("personal-chatgpt"), z.string().regex(prefixedIdPattern("src"))]);

export type AgentId = z.infer<typeof AgentIdSchema>;

export function isBuiltinAgentId(agentId: string): agentId is BuiltinAgentId {
  return (BUILTIN_AGENT_IDS as readonly string[]).includes(agentId);
}

export const MemberOwnerSchema = z.object({ kind: z.literal("member"), developerId: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

export const ProjectOwnerSchema = z.object({ kind: z.literal("project"), project: z.string().regex(AGENTX_NAME_PATTERN) }).strict();

/** Who owns an agent: one member, or a project (whose accountable maintainer answers for it). */
export const AgentOwnerSchema = z.discriminatedUnion("kind", [MemberOwnerSchema, ProjectOwnerSchema]);

/** Who an agent can be shared with: an owner variant, or everyone in the org. */
export const AgentPrincipalSchema = z.discriminatedUnion("kind", [MemberOwnerSchema, ProjectOwnerSchema, z.object({ kind: z.literal("org") }).strict()]);

export const AGENT_ACCESS_LEVELS = ["none", "view", "use", "edit", "manage"] as const;

export const AgentAccessLevelSchema = z.enum(AGENT_ACCESS_LEVELS);

export type AgentAccessLevel = z.infer<typeof AgentAccessLevelSchema>;

/** Whether `level` grants everything `wanted` does; the levels are ordered `none` < `view` < `use` < `edit` < `manage`. */
export function atLeast(level: AgentAccessLevel, wanted: AgentAccessLevel): boolean {
  return AGENT_ACCESS_LEVELS.indexOf(level) >= AGENT_ACCESS_LEVELS.indexOf(wanted);
}

/** How far an agent may act on its own: `suggest` proposes, `prepare` readies changes for a person, `run` carries them out. */
export const AutonomySchema = z.enum(["suggest", "prepare", "run"]);

/** The agent an agent builds on, pinned to one published version. */
export const BaseRefSchema = z.object({ agentId: AgentIdSchema, version: z.number().int().min(1) }).strict();

/** The principal component used by agent and session share keys. */
export function principalKey(principal: z.infer<typeof AgentPrincipalSchema>): string {
  if (principal.kind === "member") return `MEMBER#${principal.developerId}`;
  if (principal.kind === "project") return `PROJECT#${principal.project}`;
  return "ORG";
}

/** Available picker models after company/project routing and guardrails. */
export const ModelListSchema = z.object({ models: z.array(z.object({ provider: z.string(), modelId: z.string(), label: z.string(), company: ModelCompanySchema, sources: z.array(ModelSourceIdSchema), unusableReason: z.string().min(1).max(300).optional() }).strict()) }).strict();
