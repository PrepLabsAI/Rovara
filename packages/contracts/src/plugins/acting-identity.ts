// The acting-identity policy: who Rovara acts as at a code host, build system or tracker. It is separate from how people sign in to Rovara.
//  - `service` (the default): a non-human identity the customer owns (a GitHub App installation, a service principal). Every write is attributed to the person
//    who asked and the person who approved the plan.
//  - `on-behalf-of`: the person grants a short-lived delegated credential at a fresh sign-in. It serves one task's writes, is never stored past its expiry, is
//    never used to approve or merge, and never serves a task the person did not start or approve. A host that offers no delegation cannot offer this mode.
//  - Never: a person's long-lived password, cookie or security-key session copied into Rovara.
import { z } from "zod";
import { PluginKindSchema } from "./common.js";

export const ACTING_IDENTITY_MODES = ["service", "on-behalf-of"] as const;
export const ActingIdentityModeSchema = z.enum(ACTING_IDENTITY_MODES);
export type ActingIdentityMode = z.infer<typeof ActingIdentityModeSchema>;
export const DEFAULT_ACTING_IDENTITY_MODE: ActingIdentityMode = "service";

/** What a plug-in says about acting identity. */
export const ActingIdentityCapabilitiesSchema = z.object({
  service: z.boolean(),
  /** The host offers a delegated, short-lived, per-person credential. */
  delegation: z.boolean(),
}).strict();
export type ActingIdentityCapabilities = z.infer<typeof ActingIdentityCapabilitiesSchema>;

/** One plug-in's setting, chosen by a company admin. */
export const ActingIdentityPolicySchema = z.object({ plugin: PluginKindSchema, mode: ActingIdentityModeSchema }).strict();
export type ActingIdentityPolicy = z.infer<typeof ActingIdentityPolicySchema>;

/** The words every write by the service identity carries, so a reader of the host sees who asked and who approved. Names are for people; ids are Rovara's. */
export const AttributionSchema = z.object({
  requestedBy: z.object({ name: z.string().min(1).max(200), personId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  approvedBy: z.object({ name: z.string().min(1).max(200), personId: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  /** The Rovara task the write belongs to. */
  taskId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
}).strict();
export type Attribution = z.infer<typeof AttributionSchema>;

export type ActingIdentityRefusal = "mode_not_offered" | "plugin_cannot_act_as_service" | "plugin_has_no_delegation";

/**
 * Whether a plug-in may be set to a mode. `service` needs the plug-in to act as a service; `on-behalf-of` needs the host to offer delegation. A refusal
 * says why, from a fixed list. The answer never depends on the person asking.
 */
export function actingIdentityModeAllowed(capabilities: ActingIdentityCapabilities, mode: string): { ok: true; mode: ActingIdentityMode } | { ok: false; reason: ActingIdentityRefusal } {
  const parsed = ActingIdentityModeSchema.safeParse(mode);
  if (!parsed.success) return { ok: false, reason: "mode_not_offered" };
  if (parsed.data === "service") return capabilities.service ? { ok: true, mode: "service" } : { ok: false, reason: "plugin_cannot_act_as_service" };
  return capabilities.delegation ? { ok: true, mode: "on-behalf-of" } : { ok: false, reason: "plugin_has_no_delegation" };
}

/** What a delegated credential may be used for. Only one task's writes: never an approval, a merge, or anything else. */
export const DELEGATED_PURPOSES = ["task-write"] as const;
export const DelegatedPurposeSchema = z.enum(DELEGATED_PURPOSES);
export type DelegatedPurpose = z.infer<typeof DelegatedPurposeSchema>;

/** A delegated grant lives at most this long, however long the host would honour it. */
export const DELEGATED_GRANT_MAX_LIFETIME_MS = 60 * 60 * 1_000;

/**
 * What a delegated credential was granted for: one task's writes at one plug-in, by one person, from `issuedAt` until `expiresAt` (epoch milliseconds). The
 * lifetime is capped, and a grant that outlives the host's own credential (`hostExpiresAt`) does not parse.
 */
export const DelegatedGrantSchema = z.object({
  plugin: PluginKindSchema,
  taskId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  /** The Rovara person who granted it. */
  grantedBy: z.string().regex(/^[a-f0-9]{64}$/),
  purpose: DelegatedPurposeSchema,
  issuedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  /** When the host's own delegated credential stops working. */
  hostExpiresAt: z.number().int().positive(),
}).strict().superRefine((grant, ctx) => {
  if (grant.expiresAt <= grant.issuedAt) ctx.addIssue({ code: "custom", message: "a grant expires after it is issued", path: ["expiresAt"] });
  if (grant.expiresAt - grant.issuedAt > DELEGATED_GRANT_MAX_LIFETIME_MS) ctx.addIssue({ code: "custom", message: "a grant lives at most an hour", path: ["expiresAt"] });
  if (grant.expiresAt > grant.hostExpiresAt) ctx.addIssue({ code: "custom", message: "a grant does not outlive the host's credential", path: ["expiresAt"] });
});
export type DelegatedGrant = z.infer<typeof DelegatedGrantSchema>;

export type DelegatedRefusal = "expired" | "other_task" | "other_plugin" | "not_a_task_write" | "not_granted_by_a_task_person";

/**
 * Whether a delegated credential may be used for this call. It serves only the writes of the task it was granted for, at the plug-in it was granted for, before it
 * expires, and only when the person who granted it is the one who started the task or the one who approved its plan: so it never serves a task the person did
 * not start or approve, whoever minted the grant. An approval, a merge or any other purpose is refused.
 */
export function delegatedUseAllowed(grant: DelegatedGrant, use: { plugin: string; taskId: string; purpose: string; now: number; requestedBy: string; approvedBy?: string }): { ok: true } | { ok: false; reason: DelegatedRefusal } {
  if (!DelegatedPurposeSchema.safeParse(use.purpose).success || use.purpose !== grant.purpose) return { ok: false, reason: "not_a_task_write" };
  if (use.plugin !== grant.plugin) return { ok: false, reason: "other_plugin" };
  if (use.taskId !== grant.taskId) return { ok: false, reason: "other_task" };
  if (grant.grantedBy !== use.requestedBy && grant.grantedBy !== use.approvedBy) return { ok: false, reason: "not_granted_by_a_task_person" };
  if (!Number.isFinite(use.now) || use.now >= grant.expiresAt || use.now >= grant.hostExpiresAt) return { ok: false, reason: "expired" };
  return { ok: true };
}
