// Plan 2, Task 18: egress items. The DNS firewall serves one cell-wide union of the domains projects (and, in Plan 3, model sources) ask
// for, so on a hosted install a new domain reaches it only after Rovara staff approve it. One item holds one owner's domains and what was
// decided about each; every request, decision and removal is also written as an audit item that never expires.
import { z } from "zod";
import { AGENTX_NAME_PATTERN } from "./names.js";
import { OrgIdSchema, type OrgId } from "./company-scope.js";
import { orgScoped, type OrgKey } from "./company-scope.js";

/** The partition of every owner's egress item, and of the sync marker (Task 19), which is the one item whose sort key is not an org's. */
export const EGRESS_DOMAINS_PK = "EGRESS_DOMAINS";
/** The partition of the audit trail. Its items have no TTL. */
export const EGRESS_AUDIT_PK = "EGRESS_AUDIT";

/** Who asks for the domains: a project, or (Plan 3) a model source. Both go through the same items and the same approval. */
export const EgressOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), project: z.string().regex(AGENTX_NAME_PATTERN) }).strict(),
  z.object({ kind: z.literal("model-source"), sourceId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }).strict(),
]);
export type EgressOwner = z.infer<typeof EgressOwnerSchema>;

/** The org-scoped part of an item's sort key. */
export function egressOwnerSegment(owner: EgressOwner): string {
  return owner.kind === "project" ? `PROJECT#${owner.project}` : `SOURCE#${owner.sourceId}`;
}

export function egressDomainsKey(orgId: OrgId, owner: EgressOwner): OrgKey {
  return { pk: EGRESS_DOMAINS_PK, sk: orgScoped(orgId, egressOwnerSegment(owner)) };
}

/** The sort-key prefix of every item of one org (`ORG#<id>#`), for a query on the egress partition. */
export function egressOrgSkPrefix(orgId: OrgId): string {
  return orgScoped(orgId, "");
}

/** The sort-key prefix every org's items share; the sync marker's `SYNC` does not match it. */
export const EGRESS_ALL_ORGS_SK_PREFIX = "ORG#";

/**
 * The marker Task 19's sync reads. Every write that changes the union sets `dirtyAt` and adds one to `dirtySeq`; the sync, once the firewall
 * holds the union it read, sets `syncedAt`, `syncedSeq` (the `dirtySeq` it read) and `syncedListId`, and only if `dirtySeq` is still that. The marker is
 * dirty while `dirtySeq` is greater than `syncedSeq` (absent reads as 0). `dirtyAt` is for people: two changes in one millisecond share it.
 */
export const EGRESS_SYNC_KEY: OrgKey = { pk: EGRESS_DOMAINS_PK, sk: "SYNC" };

export const EgressSyncMarkerSchema = z.object({
  dirtyAt: z.string(),
  dirtySeq: z.number().int().nonnegative(),
  syncedAt: z.string().optional(),
  syncedSeq: z.number().int().nonnegative().optional(),
  /** The firewall list the last sync filled: a marker that last filled another list reads as dirty, so a replaced (empty) list is filled again. */
  syncedListId: z.string().optional(),
});
export type EgressSyncMarker = z.infer<typeof EgressSyncMarkerSchema>;

export const EgressDomainStatusSchema = z.enum(["pending", "approved", "rejected"]);
export type EgressDomainStatus = z.infer<typeof EgressDomainStatusSchema>;

export const EgressDomainEntrySchema = z.object({
  domain: z.string(),
  status: EgressDomainStatusSchema,
  requestedAt: z.string(),
  requestedBy: z.string(),
  decidedAt: z.string().optional(),
  decidedBy: z.string().optional(),
  reason: z.string().optional(),
});
export type EgressDomainEntry = z.infer<typeof EgressDomainEntrySchema>;

export const EgressDomainsItemSchema = z.object({
  orgId: OrgIdSchema,
  owner: EgressOwnerSchema,
  active: z.boolean(),
  domains: z.array(EgressDomainEntrySchema),
  updatedAt: z.string(),
});
export type EgressDomainsItem = z.infer<typeof EgressDomainsItemSchema>;

export const EgressAuditActionSchema = z.enum(["requested", "approved", "rejected", "removed", "auto_approved"]);
export type EgressAuditAction = z.infer<typeof EgressAuditActionSchema>;

export const EgressAuditItemSchema = z.object({
  orgId: OrgIdSchema,
  owner: EgressOwnerSchema,
  domain: z.string(),
  action: EgressAuditActionSchema,
  actor: z.object({ kind: z.enum(["developer", "operator"]), id: z.string() }),
  reason: z.string().optional(),
  at: z.string(),
});
export type EgressAuditItem = z.infer<typeof EgressAuditItemSchema>;

const RequestIdSchema = z.string().uuid();
const DecisionTarget = { requestId: RequestIdSchema, orgId: OrgIdSchema, owner: EgressOwnerSchema, domain: z.string().min(1).max(253) };

/** `POST /v1/admin/egress/approve`. */
export const EgressApproveBodySchema = z.object(DecisionTarget).strict();
/** `POST /v1/admin/egress/reject`: the reason is what the project's maintainers are told. */
export const EgressRejectBodySchema = z.object({ ...DecisionTarget, reason: z.string().trim().min(1).max(200) }).strict();

export const EgressPendingResponseSchema = z.object({
  pending: z.array(z.object({
    orgId: OrgIdSchema,
    orgName: z.string(),
    owner: EgressOwnerSchema,
    domain: z.string(),
    requestedAt: z.string(),
    requestedBy: z.object({ developerId: z.string(), name: z.string() }),
  })),
});
export type EgressPendingResponse = z.infer<typeof EgressPendingResponseSchema>;

/** What an operator is told about an approval or rejection. */
export const EgressDecisionResponseSchema = z.object({ orgId: OrgIdSchema, owner: EgressOwnerSchema, domain: z.string(), status: z.enum(["approved", "rejected"]) });
export type EgressDecisionResponse = z.infer<typeof EgressDecisionResponseSchema>;

export const EGRESS_CONFLICT_MESSAGE = "the allowed domains changed while saving; reload and try again";
export const EGRESS_SYNC_PENDING_WARNING = "allowed domains will apply within 5 minutes";
export const egressNotPendingMessage = (domain: string) => `${domain} is not waiting for approval`;
export const egressPendingWarning = (domain: string) => `${domain} is waiting for Rovara to approve it`;
export const egressRejectedWarning = (domain: string, reason: string | undefined) => `Rovara did not approve ${domain}: ${reason ?? "no reason was given"}`;

/** The text form of an owner on a command line: `project:<name>` or `model-source:<id>`. */
export function parseEgressOwnerText(text: string): EgressOwner | undefined {
  const separator = text.indexOf(":");
  if (separator < 0) return undefined;
  const kind = text.slice(0, separator);
  const value = text.slice(separator + 1);
  const parsed = EgressOwnerSchema.safeParse(kind === "project" ? { kind, project: value } : { kind, sourceId: value });
  return parsed.success ? parsed.data : undefined;
}

export function formatEgressOwner(owner: EgressOwner): string {
  return owner.kind === "project" ? `project:${owner.project}` : `model-source:${owner.sourceId}`;
}
