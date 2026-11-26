// Guided onboarding PR 16 (DEC 254n item 3): Archive and Restore of a project on the deployed developer API, preview first. Cloud's ArchiveProject and RestoreProject
// screens call these AS the signed-in person, through the web app's full-access sign-in client (the route table gives them `full`, never a named scope):
//
//   GET  /v1/dev/client/projects/{project}/archive-preview    the project's lifecycle state, the revisions a change must name, what archiving does, and whether the caller may
//   POST /v1/dev/client/projects/{project}/archive            archive it (Code's ReviewedProjectArchiveBody; answers ReviewedProjectArchiveOutcome)
//   GET  /v1/dev/client/projects/{project}/restore-preview    the same for a restore
//   POST /v1/dev/client/projects/{project}/restore            restore it (ReviewedProjectRestoreBody; answers ReviewedProjectRestoreOutcome)
//
// Rules:
//   - Only with the company layer: the company is the caller's LIVE membership, read again on every request, never a header, a query, a body or a token claim.
//   - Who may change: a live owner or admin of the project's company, or an administrator of that project (its grant). A person who uses the project (a developer grant)
//     sees the preview with no action and is refused a change in fixed words. Anyone else, another company's project, a legacy project of the install and a missing
//     one all answer the same "project not found".
//   - What archiving is: the project's engine state row (`projectMetaKey`, the row the core engine already reads) says `archived`. The engine then refuses new work on it
//     (task start, a task's next round, a setup run, the saved environments). Running tasks stop at their next step; linked Slack channels stay linked and start nothing;
//     nothing is deleted. Restore sets it back to `active`. Only the core engine reads that row, so an archive is refused for a company whose new tasks the engine switch does not
//     send to the core (`archiveTakesEffect`): Code never promises a stop it would not enforce. Restore is always allowed.
//   - One change at a time: each change names the lifecycle revision and the project revision it was previewed at, and is written only while both still hold
//     (the state row's condition, and a check that no newer project revision row exists, in the same transaction). Two changes at once: one wins, the other is stale. A repeat of the same request id by the same person answers its first receipt.
//   - Every change keeps a receipt (by request id) and an audit row naming the person and why they were allowed, in the same transaction, under the company's own keys.
//   - A change may also name the project incarnation its preview showed (`expectedProjectIncarnation`, optional so an older Cloud still works). When it names one and it is not the project's
//     current one (the project was deleted and created again under the same name), the change is refused with LIFECYCLE_INCARNATION_CHANGED before anything is written, and the refusal is
//     kept as an audit row (PROJECT_LIFECYCLE_REFUSAL). A change that names none is fenced only on the incarnation read at confirm time, as before.
//   - Bodies are validated at runtime and strictly; every refusal is a fixed sentence that never echoes what was sent.
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  AGENTX_NAME_PATTERN, OrgIdSchema, ReviewedProjectArchiveBodySchema, ReviewedProjectRestoreBodySchema, agentXError, companyScoped, orgProjectCatalogKey, projectMetaKey,
  type OrgId, type OrgRole, type ReviewedProjectArchiveOutcome, type ReviewedProjectArchivePreview, type ReviewedProjectRestoreOutcome, type ReviewedProjectRestorePreview,
} from "@agentx/contracts";
import { recordInCompany } from "./company-check.js";
import { namedCompany, namedCompanyLatestRevisionRow, revisionKeyFor } from "./company-layout.js";
import { projectKey } from "./project-records.js";

export const LIFECYCLE_NOT_FOUND = "project not found";
export const LIFECYCLE_NOT_ALLOWED = "Only company owners and admins, or this project's admins, can archive or restore it.";
export const LIFECYCLE_BODY = "the request is not valid";
export const LIFECYCLE_STALE = "The project changed. Review it again before you archive or restore it.";
/** The incarnation fence: the project is not the one the person previewed (deleted and created again under the same name). Stable words: Cloud tells this refusal from a plain stale one by this exact sentence. */
export const LIFECYCLE_INCARNATION_CHANGED = "This project changed since you previewed it; preview again.";
export const LIFECYCLE_UNREADABLE = "the project's state could not be read just now; try again";
export const ARCHIVE_NOT_ON_ENGINE = "Archiving isn't available for this company yet: its tasks don't run on the engine that stops work on an archived project.";

export type LifecycleAction = "archive-preview" | "archive" | "restore-preview" | "restore";
type Basis = "company-owner" | "company-admin" | "project-admin";

/** What the routes read through the deployment (each read is the deployment's own, bounded). */
export interface ProjectLifecycleContext {
  documentClient: { send(command: unknown): Promise<unknown> };
  /** The State table: projects, grants, the engine's project rows. */
  tableName: string;
  now: () => number;
  /** The caller's live company membership; undefined when they have none (or it was revoked). */
  membershipOf(personId: string): Promise<{ companyId: string; role: OrgRole } | undefined>;
  /** The person's grant on the project (by name), whatever company: the project's own company is checked separately. */
  grantRole(personId: string, project: string): Promise<"developer" | "administrator" | undefined>;
  /** Whether an archive takes effect for the company: its new tasks start on the core engine, the only one that reads the archived state. False: archive is refused (restore stays open). */
  archiveTakesEffect(companyId: string): boolean;
  /** How many Slack channels of the company are linked to the project. Throws when it cannot be read. */
  linkedSlackChannels(companyId: string, project: string): Promise<number>;
}

/** The rule (DEC 254n item 3): owners, admins and the project's administrators manage; a person who uses the project sees; anyone else gets nothing. */
export function lifecycleAccess(role: OrgRole, grant: "developer" | "administrator" | undefined): "manage" | "view" | "none" {
  if (role === "owner" || role === "admin") return "manage";
  if (grant === "administrator") return "manage";
  if (grant === "developer") return "view";
  return "none";
}

/** The partition of one project's lifecycle receipts and audit rows, under the company's own key. */
export const lifecyclePartition = (companyId: string, project: string): string => companyScoped(companyId, `PROJECT_LIFECYCLE#${project}`);
export const lifecycleRequestKey = (companyId: string, project: string, requestId: string) => ({ pk: lifecyclePartition(companyId, project), sk: `REQUEST#${requestId}` });
export const lifecycleAuditPrefix = "AUDIT#";
/** A refused change (not a done one) is kept under its own prefix, so the done-change audit rows stay exactly the changes that happened. */
export const lifecycleRefusalPrefix = "REFUSAL#";

import { requireProjectIncarnation } from "../core/project-incarnation.js";

const MetaRow = z.object({
  status: z.enum(["active", "archived"]).optional(),
  lifecycleRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1).optional(),
}).passthrough();
const ProjectName = z.string().regex(AGENTX_NAME_PATTERN);
const ReceiptRow = z.object({ entityType: z.literal("PROJECT_LIFECYCLE_REQUEST"), action: z.enum(["archive", "restore"]), personId: z.string(), receipt: z.record(z.string(), z.unknown()) }).passthrough();

interface Current { companyId: OrgId; project: string; status: "active" | "archived"; lifecycleRevision: number; projectRevision: number; access: "manage" | "view"; basis: Basis | undefined; incarnationRevision?: number }

function jsonOf(body: string | undefined): unknown {
  if (body === undefined || body === "") return undefined;
  try { return JSON.parse(body) as unknown; } catch { return undefined; }
}

const conditionFailed = (error: unknown): boolean => {
  const name = (error as { name?: unknown } | undefined)?.name;
  return name === "ConditionalCheckFailedException" || name === "TransactionCanceledException";
};

/** Pre-rollout rows remain readable; initialized identities must validate exactly. */
function readLifecycleIncarnation(companyId: string, project: string, parsed: Record<string, unknown>, row: unknown): { incarnationRevision?: number } {
  if (parsed["incarnationRevision"] === undefined) return {};
  try { return { incarnationRevision: requireProjectIncarnation(companyId, project, row as Record<string, unknown>) }; }
  catch { throw agentXError("RUNTIME_UNAVAILABLE", LIFECYCLE_UNREADABLE); }
}

function lifecycleIncarnationFence(current: Current) {
  return current.incarnationRevision === undefined
    ? { condition: "attribute_not_exists(incarnationRevision)", values: {} }
    : { condition: "incarnationRevision = :incarnation AND companyId = :company AND #project = :project AND entityType = :entity", values: { ":incarnation": current.incarnationRevision } };
}

/** Who the caller is to this project, and the project's lifecycle state, read now. Refuses with the uniform "project not found" for anyone who may not see it. */
async function readCurrent(ctx: ProjectLifecycleContext, personId: string, rawProject: string): Promise<Current> {
  const membership = await ctx.membershipOf(personId);
  const company = OrgIdSchema.safeParse(membership?.companyId);
  if (membership === undefined || !company.success) throw agentXError("AUTH_REQUIRED", "your AgentX sign-in has ended; run agentx login <url> again");
  let project: string;
  try { project = decodeURIComponent(rawProject); } catch { throw agentXError("NOT_FOUND", LIFECYCLE_NOT_FOUND); }
  if (!ProjectName.safeParse(project).success) throw agentXError("NOT_FOUND", LIFECYCLE_NOT_FOUND);
  // DEC 254zzz80: a named company's project is the latest revision in its own partition (company-layout.ts checks the partition and the core's order).
  const named = namedCompany(company.data);
  const row = named !== undefined ? await namedCompanyLatestRevisionRow(ctx.documentClient, ctx.tableName, named, project) : (await ctx.documentClient.send(new QueryCommand({
    TableName: ctx.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :rev)",
    ExpressionAttributeValues: { ":pk": `PROJECT#${project}`, ":rev": "REV#" }, ScanIndexForward: false, Limit: 1, ConsistentRead: true,
  })) as { Items?: Array<Record<string, unknown>> }).Items?.[0];
  // The project's own company, as its latest revision names it: a legacy row with no company is the install's implicit company's, never the caller's.
  if (row === undefined || (named === undefined && !recordInCompany(row, company.data))) throw agentXError("NOT_FOUND", LIFECYCLE_NOT_FOUND);
  const revision = (row["definition"] as { revision?: unknown } | undefined)?.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) throw agentXError("NOT_FOUND", LIFECYCLE_NOT_FOUND);
  // R2-F1 review L2: a named company's catalog pointer that names another revision than the one read (its row unusable: drift) is not a project a change can be fenced
  // on (the change would be stale forever): it answers "not found", the same as any project the caller may not change.
  if (named !== undefined) {
    const catalog = (await ctx.documentClient.send(new GetCommand({ TableName: ctx.tableName, Key: orgProjectCatalogKey(named, project), ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
    if (catalog !== undefined && catalog["latestRevision"] !== revision) throw agentXError("NOT_FOUND", LIFECYCLE_NOT_FOUND);
  }
  const grant = await ctx.grantRole(personId, project);
  const access = lifecycleAccess(membership.role, grant);
  if (access === "none") throw agentXError("NOT_FOUND", LIFECYCLE_NOT_FOUND);
  const basis: Basis | undefined = access !== "manage" ? undefined : membership.role === "owner" ? "company-owner" : membership.role === "admin" ? "company-admin" : "project-admin";
  const meta = await ctx.documentClient.send(new GetCommand({ TableName: ctx.tableName, Key: projectMetaKey(company.data, project), ConsistentRead: true })) as { Item?: unknown };
  const parsed = meta.Item === undefined ? { success: true as const, data: {} as z.infer<typeof MetaRow> } : MetaRow.safeParse(meta.Item);
  if (!parsed.success) throw agentXError("RUNTIME_UNAVAILABLE", LIFECYCLE_UNREADABLE);
  return { ...readLifecycleIncarnation(company.data, project, parsed.data, meta.Item), companyId: company.data, project, status: parsed.data.status ?? "active", lifecycleRevision: parsed.data.lifecycleRevision ?? 0, projectRevision: revision, access, basis };
}

async function channelsOf(ctx: ProjectLifecycleContext, current: Current): Promise<number> {
  try {
    const count = await ctx.linkedSlackChannels(current.companyId, current.project);
    if (!Number.isSafeInteger(count) || count < 0 || count > 10_000) throw new Error("unreadable");
    return count;
  } catch { throw agentXError("RUNTIME_UNAVAILABLE", LIFECYCLE_UNREADABLE); }
}

async function archivePreview(ctx: ProjectLifecycleContext, current: Current): Promise<ReviewedProjectArchivePreview> {
  return {
    orgId: current.companyId, project: current.project, status: current.status, expectedRevision: current.lifecycleRevision, expectedProjectRevision: current.projectRevision, ...(current.incarnationRevision === undefined ? {} : { expectedProjectIncarnation: current.incarnationRevision }),
    checkedAt: new Date(ctx.now()).toISOString(), access: { actions: current.access === "manage" && current.status === "active" && ctx.archiveTakesEffect(current.companyId) ? ["archive"] : [] },
    impact: { stopsNewWork: true, stopsRunningTasksAtNextStep: true, linkedSlackChannels: await channelsOf(ctx, current), slackChannelsStayLinked: true, deletesNothing: true },
  };
}

async function restorePreview(ctx: ProjectLifecycleContext, current: Current): Promise<ReviewedProjectRestorePreview> {
  return {
    orgId: current.companyId, project: current.project, status: current.status, expectedRevision: current.lifecycleRevision, expectedProjectRevision: current.projectRevision, ...(current.incarnationRevision === undefined ? {} : { expectedProjectIncarnation: current.incarnationRevision }),
    checkedAt: new Date(ctx.now()).toISOString(), prerequisites: "not_required", access: { actions: current.access === "manage" && current.status === "archived" ? ["restore"] : [] },
    impact: { allowsNewWork: true, linkedSlackChannels: await channelsOf(ctx, current) },
  };
}

/**
 * The checks that the previewed project revision is still the latest, in the change's transaction. Legacy: no newer revision row. A named company (DEC 254zzz80, its own partition, read
 * in the core's order): the catalog still points at it (or there is no catalog row), and no newer revision row exists unless it is a candidate (a setup waiting for approval is not the
 * latest until its approval moves the catalog, which the first check sees).
 */
function stillLatest(tableName: string, current: Current) {
  if (namedCompany(current.companyId) === undefined) {
    return [{ ConditionCheck: { TableName: tableName, Key: projectKey(current.project, current.projectRevision + 1), ConditionExpression: "attribute_not_exists(pk)" } }];
  }
  return [
    { ConditionCheck: { TableName: tableName, Key: orgProjectCatalogKey(current.companyId, current.project), ConditionExpression: "attribute_not_exists(pk) OR latestRevision = :revision",
      ExpressionAttributeValues: { ":revision": current.projectRevision } } },
    { ConditionCheck: { TableName: tableName, Key: revisionKeyFor(current.companyId, current.project, current.projectRevision + 1), ConditionExpression: "attribute_not_exists(pk) OR candidate = :candidate",
      ExpressionAttributeValues: { ":candidate": true } } },
  ];
}

/**
 * The audit row of a change refused because the project is not the incarnation previewed: who, which change, why, and the two numbers (never the project's data). Best effort: the refusal stands
 * when the row cannot be written, and it never touches the project's state row, a receipt or a done-change audit row.
 */
async function recordRefusal(ctx: ProjectLifecycleContext, personId: string, current: Current, action: "archive" | "restore", body: { requestId: string; expectedProjectIncarnation?: number | undefined }): Promise<void> {
  const at = new Date(ctx.now()).toISOString();
  try {
    await ctx.documentClient.send(new PutCommand({ TableName: ctx.tableName, ConditionExpression: "attribute_not_exists(pk)", Item: {
      pk: lifecyclePartition(current.companyId, current.project), sk: `${lifecycleRefusalPrefix}${at}#${body.requestId}`, entityType: "PROJECT_LIFECYCLE_REFUSAL",
      companyId: current.companyId, project: current.project, action, personId, basis: current.basis, reason: "project_incarnation_changed",
      previewedIncarnation: body.expectedProjectIncarnation, ...(current.incarnationRevision === undefined ? {} : { currentIncarnation: current.incarnationRevision }), at,
    } }));
  } catch { /* the refusal stands without its row */ }
}

/** Refuses the change (audited, nothing else written) when the person named an incarnation and it is not the project's now. Names none: no fence from the person's side. A project with no incarnation never equals a named one. */
async function fenceIncarnation(ctx: ProjectLifecycleContext, personId: string, current: Current, action: "archive" | "restore", body: { requestId: string; expectedProjectIncarnation?: number | undefined }): Promise<void> {
  if (body.expectedProjectIncarnation === undefined || body.expectedProjectIncarnation === current.incarnationRevision) return;
  await recordRefusal(ctx, personId, current, action, body);
  throw agentXError("CHANGE_STALE", LIFECYCLE_INCARNATION_CHANGED);
}

/** One change (archive or restore), after the caller and the body were checked. */
async function change(ctx: ProjectLifecycleContext, personId: string, current: Current, action: "archive" | "restore", body: { requestId: string; expectedOrgId?: string | undefined; expectedRevision: number; expectedProjectRevision: number; expectedProjectIncarnation?: number | undefined }): Promise<{ receipt: Record<string, unknown>; replayed: boolean }> {
  if (current.access !== "manage" || current.basis === undefined) throw agentXError("FORBIDDEN", LIFECYCLE_NOT_ALLOWED);
  // The incarnation the person previewed must be the project's now, checked before a receipt is read or anything is written (a replay of an old request must not answer for a project that is a new one).
  // Absent: no fence from the person's side (an older Cloud). A project with no incarnation never equals a named one.
  await fenceIncarnation(ctx, personId, current, action, body);
  const requestKey = lifecycleRequestKey(current.companyId, current.project, body.requestId);
  const readReceipt = async () => {
    const answer = await ctx.documentClient.send(new GetCommand({ TableName: ctx.tableName, Key: requestKey, ConsistentRead: true })) as { Item?: unknown };
    if (answer.Item === undefined) return undefined;
    const row = ReceiptRow.safeParse(answer.Item);
    // A request id already used by someone else, or for the other change, never answers their receipt.
    if (!row.success || row.data.personId !== personId || row.data.action !== action) throw agentXError("CHANGE_STALE", LIFECYCLE_STALE);
    return row.data.receipt;
  };
  const earlier = await readReceipt();
  if (earlier !== undefined) return { receipt: earlier, replayed: true };
  // An archive the company's engine would not honour is refused rather than promised (restore is always allowed: it only lifts a refusal).
  if (action === "archive" && !ctx.archiveTakesEffect(current.companyId)) throw agentXError("RUNTIME_UNAVAILABLE", ARCHIVE_NOT_ON_ENGINE);
  const from = action === "archive" ? "active" : "archived";
  const to = action === "archive" ? "archived" : "active";
  if ((body.expectedOrgId !== undefined && body.expectedOrgId !== current.companyId) || body.expectedRevision !== current.lifecycleRevision
    || body.expectedProjectRevision !== current.projectRevision || current.status !== from) throw agentXError("CHANGE_STALE", LIFECYCLE_STALE);
  const at = new Date(ctx.now()).toISOString();
  const next = body.expectedRevision + 1;
  const receipt = action === "archive"
    ? { project: current.project, status: "archived", revision: next, projectRevision: current.projectRevision, archivedAt: at, egressReconciliation: "pending" }
    : { project: current.project, status: "active", revision: next, projectRevision: current.projectRevision, restoredAt: at, egressReconciliation: "pending" };
  const metaKey = projectMetaKey(current.companyId, current.project);
  // The state row is changed only while it still says what the preview said: absent revision means 0 (a row written before lifecycle revisions, or no row).
  const condition = body.expectedRevision === 0
    ? `attribute_not_exists(lifecycleRevision) AND ${from === "active" ? "(attribute_not_exists(#status) OR #status = :from)" : "#status = :from"}`
    : "lifecycleRevision = :expected AND #status = :from";
  const incarnation = lifecycleIncarnationFence(current);
  try {
    await ctx.documentClient.send(new TransactWriteCommand({ TransactItems: [
      // The project revision the preview named is still the latest: no newer revision row landed in between.
      ...stillLatest(ctx.tableName, current),
      { Update: {
        TableName: ctx.tableName, Key: metaKey,
        UpdateExpression: "SET entityType = :entity, companyId = :company, #project = :project, #status = :to, lifecycleRevision = :next, lifecycleChangedAt = :at, lifecycleChangedBy = :person",
        ConditionExpression: `(${condition}) AND ${incarnation.condition}`,
        ExpressionAttributeNames: { "#status": "status", "#project": "project" },
        ExpressionAttributeValues: { ":entity": "PROJECT_META", ":company": current.companyId, ":project": current.project, ":to": to, ":next": next, ":at": at, ":person": personId, ":from": from,
          ...(body.expectedRevision === 0 ? {} : { ":expected": body.expectedRevision }),
          ...incarnation.values },
      } },
      { Put: { TableName: ctx.tableName, ConditionExpression: "attribute_not_exists(pk)", Item: {
        ...requestKey, entityType: "PROJECT_LIFECYCLE_REQUEST", companyId: current.companyId, project: current.project, action, personId, receipt, at,
      } } },
      { Put: { TableName: ctx.tableName, ConditionExpression: "attribute_not_exists(pk)", Item: {
        pk: lifecyclePartition(current.companyId, current.project), sk: `${lifecycleAuditPrefix}${at}#${body.requestId}`, entityType: "PROJECT_LIFECYCLE_AUDIT",
        companyId: current.companyId, project: current.project, action, personId, basis: current.basis, fromRevision: body.expectedRevision, toRevision: next,
        projectRevision: current.projectRevision, at,
      } } },
    ] }));
  } catch (error) {
    if (!conditionFailed(error)) throw error;
    // The same request may have won meanwhile (a retry racing itself): its receipt answers. Anything else changed the project first.
    const raced = await readReceipt();
    if (raced !== undefined) return { receipt: raced, replayed: true };
    throw agentXError("CHANGE_STALE", LIFECYCLE_STALE);
  }
  return { receipt, replayed: false };
}

/** The four routes. The caller is already authenticated (a live, not removed person) and its route row (`full`) applied. */
export async function routeProjectLifecycle(ctx: ProjectLifecycleContext, input: { personId: string; project: string; action: LifecycleAction; body: string | undefined }): Promise<ReviewedProjectArchivePreview | ReviewedProjectRestorePreview | ReviewedProjectArchiveOutcome | ReviewedProjectRestoreOutcome> {
  const current = await readCurrent(ctx, input.personId, input.project);
  if (input.action === "archive-preview") return archivePreview(ctx, current);
  if (input.action === "restore-preview") return restorePreview(ctx, current);
  if (input.action === "archive") {
    const parsed = ReviewedProjectArchiveBodySchema.safeParse(jsonOf(input.body));
    if (!parsed.success) throw agentXError("CONFIG_INVALID", LIFECYCLE_BODY);
    const done = await change(ctx, input.personId, current, "archive", parsed.data);
    const after = await readCurrent(ctx, input.personId, input.project);
    return { receipt: done.receipt as ReviewedProjectArchiveOutcome["receipt"], replayed: done.replayed, current: await archivePreview(ctx, after),
      effects: { egress: "not_attempted", archiveHook: done.replayed ? "not_attempted" : "not_configured" } };
  }
  const parsed = ReviewedProjectRestoreBodySchema.safeParse(jsonOf(input.body));
  if (!parsed.success) throw agentXError("CONFIG_INVALID", LIFECYCLE_BODY);
  const done = await change(ctx, input.personId, current, "restore", parsed.data);
  const after = await readCurrent(ctx, input.personId, input.project);
  return { receipt: done.receipt as ReviewedProjectRestoreOutcome["receipt"], replayed: done.replayed, current: await restorePreview(ctx, after), effects: { egress: "not_attempted" } };
}
