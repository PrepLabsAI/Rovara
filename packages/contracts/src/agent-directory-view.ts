// The company-wide agent directory's answer (lead 4 L4-MF3): `GET /v1/app/agents?scope=...`, read by Cloud's agents screen through its `AgentDirectoryResponseReaderSchema`.
// This is the directory slice of Cloud's `agent-web-views.ts` (AgentView, the scope list and the directory answer), with the same fields, bounds and strictness: Cloud's reader parses what
// Code sends. Code has no copy of the rest of that file (profiles, drafts, shares, spend), so only this slice lives here; a change to either side's AgentView changes both.
import { z } from "zod";
import { AgentAccessLevelSchema, AgentIdSchema, AgentOwnerSchema, BaseRefSchema } from "./agent.js";

const Version = z.number().int().positive();
const Usd = z.number().finite().nonnegative();

/** The views the directory offers. `all` (every agent in the company) is the default; the hosted route serves them to a company owner or administrator only. */
export const AgentScopeSchema = z.enum(["all", "mine", "shared", "builtin"]);
export type AgentScope = z.infer<typeof AgentScopeSchema>;

export const AgentDeveloperRefSchema = z.object({ developerId: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

export const AgentViewSchema = z.object({
  agentId: AgentIdSchema, name: z.string(), description: z.string(), builtin: z.boolean(), access: AgentAccessLevelSchema, status: z.enum(["active", "archived"]),
  owner: AgentOwnerSchema.optional(), accountable: AgentDeveloperRefSchema.optional(), currentVersion: Version.optional(), pinnedVersion: Version.optional(), latestVersion: z.number().int().nonnegative(), draftRevision: Version.optional(),
  monthlyBudgetUsd: Usd.optional(), maxPerRunUsd: Usd.optional(), createdBy: z.string().optional(), createdAt: z.string().optional(), updatedAt: z.string().optional(),
  disabled: z.boolean().optional(), needsLaterConnectors: z.string().optional(), extends: BaseRefSchema.optional(), updateAvailable: z.object({ from: Version, to: Version }).strict().optional(),
}).strict();
export type AgentView = z.infer<typeof AgentViewSchema>;

export const AgentDirectoryResponseSchema = z.object({ agents: z.array(AgentViewSchema) }).strict();
export type AgentDirectoryResponse = z.infer<typeof AgentDirectoryResponseSchema>;
