// A project's own setup-run limits (SETUP-LIMITS): what the owner or an admin may change on the hosted app, and what the next setup run starts with.
//
//   `SETUP_DRAFT#<project>` / LIMITS   one item per project: { revision, limits (any subset of the five limits), requestId, updatedAt, updatedBy }. No expiry: it stays until a person changes it.
//   `SETUP_LOCKS` / META               the company's caps (read only here: a lock only ever lowers a project's value; `effectiveSetupAgentLimits` does the cutting).
//
// Rules:
//   - Every value is a whole number from 1 up to the contract's hard maximum (`SETUP_AGENT_LIMITS_MAX`), and never above the company's cap for that limit. A body that breaks either is refused whole; nothing is written.
//   - A write names the revision the person read (0: none yet). A different revision is `CHANGE_STALE` and nothing is written. The row is replaced under a condition on that revision, so two writers cannot both win.
//   - A write carries a request id kept on the row: a repeat of the same id with the same limits answers the current view and writes nothing; the same id with other limits is `IDEMPOTENCY_CONFLICT`.
//   - The audit record commits in the same transaction as the row (or is recorded first when the sink writes elsewhere), so no change is made that the ledger does not hold.
//   - The next run reads these through `setupLimitSettingReader` (cut down to the company's cap). A run already going keeps the limits it started with (the pointer holds them).
//   - A row or a lock that does not read is never guessed at: a write is refused (503) and a run is held to the defaults (never looser than a damaged row's reading).
import { z } from "zod";
import {
  ON_THE_WEBSITE_MESSAGE, SETUP_AGENT_LIMITS_DEFAULT, SETUP_AGENT_LIMITS_MAX, SETUP_AGENT_LIMIT_NAMES, SetupAgentLimitSettingSchema, agentXError, effectiveSetupAgentLimits, setupLimitsKey, setupLocksKey, when,
  type AuditEvent, type AuditSink, type DocumentStore, type OrgId, type SetupAgentLimitSetting, type SetupAgentLimits,
} from "@agentx/contracts";

export const SETUP_LIMITS_ENTITY = "SETUP_LIMITS";
export const SETUP_LIMITS_UNREADABLE = "The project's setup limits could not be read just now. Try again.";
export const SETUP_LIMITS_STALE = "The limits changed since you looked. Read them again.";
export const SETUP_LIMITS_REPLAY_DIFFERS = "That request id was already used for different limits.";
export const SETUP_LIMITS_AUDIT_UNAVAILABLE = "The record of this change could not be written, so nothing was done. Try again.";

/** What the routes answer: the project's own setting, the company's caps, what a run started now would use, and the bounds. */
export interface SetupLimitsView {
  revision: number;
  limits: SetupAgentLimitSetting;
  companyLock: SetupAgentLimitSetting;
  effective: SetupAgentLimits;
  defaults: SetupAgentLimits;
  maxima: SetupAgentLimits;
}

export interface SetupLimitsDeps {
  store: Pick<DocumentStore, "get" | "transact">;
  companyId: OrgId;
  now: () => number;
}

/** The body of a change: the request id, the revision the person read, and the project's own limits as they should be (any subset; none removes them all). */
export const SetupLimitsBodySchema = z.object({
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().min(0).max(1_000_000_000),
  limits: SetupAgentLimitSettingSchema,
}).strict();
export type SetupLimitsBody = z.infer<typeof SetupLimitsBodySchema>;

interface Row { revision: number; limits: SetupAgentLimitSetting; requestId: string | undefined }

const plain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The project's row, `none` when there is no row, or `unreadable`. Never throws for a damaged row. */
async function readRow(deps: SetupLimitsDeps, project: string): Promise<Row | "none" | "unreadable"> {
  const item = await deps.store.get(setupLimitsKey(deps.companyId, project));
  if (item === undefined) return "none";
  const limits = SetupAgentLimitSettingSchema.safeParse(item["limits"]);
  const revision = item["revision"];
  if (item["entityType"] !== SETUP_LIMITS_ENTITY || item["orgId"] !== deps.companyId || item["project"] !== project || !limits.success || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) return "unreadable";
  const requestId = item["requestId"];
  return { revision, limits: limits.data, requestId: typeof requestId === "string" ? requestId : undefined };
}

/**
 * The company's caps as stored, for the limits it names. No row: none. A row whose limits do not read is held to the defaults for every limit (a damaged lock is stricter than none, never looser);
 * a value that does not read gives that limit's default (as `effectiveSetupAgentLimits` does).
 */
export async function readSetupLimitLock(deps: Pick<SetupLimitsDeps, "store" | "companyId">): Promise<SetupAgentLimitSetting> {
  const item = await deps.store.get(setupLocksKey(deps.companyId));
  if (item === undefined) return {};
  const raw = item["limits"];
  if (raw === undefined) return {};
  if (!plain(raw)) return { ...SETUP_AGENT_LIMITS_DEFAULT };
  const lock: SetupAgentLimitSetting = {};
  for (const name of SETUP_AGENT_LIMIT_NAMES) {
    if (!(name in raw)) continue;
    const one = z.number().int().min(1).max(SETUP_AGENT_LIMITS_MAX[name]).safeParse(raw[name]);
    lock[name] = one.success ? one.data : SETUP_AGENT_LIMITS_DEFAULT[name];
  }
  return lock;
}

/** What `GET .../setup-agent/limits` answers. */
export async function readSetupLimits(deps: SetupLimitsDeps, project: string): Promise<SetupLimitsView> {
  const row = await readRow(deps, project);
  if (row === "unreadable") throw agentXError("RUNTIME_UNAVAILABLE", SETUP_LIMITS_UNREADABLE);
  const lock = await readSetupLimitLock(deps);
  const own = row === "none" ? {} : row.limits;
  return {
    revision: row === "none" ? 0 : row.revision, limits: { ...own }, companyLock: lock, effective: effectiveSetupAgentLimits(own, lock),
    defaults: { ...SETUP_AGENT_LIMITS_DEFAULT }, maxima: { ...SETUP_AGENT_LIMITS_MAX },
  };
}

/**
 * The setting the next run starts from, for `SetupAgentDeps.limitSetting`: the project's own limits cut down to the company's cap. A row that does not read gives the defaults. Never throws for a damaged row;
 * a store that cannot be reached throws (a start then fails rather than run on guessed limits).
 */
export function setupLimitSettingReader(deps: Pick<SetupLimitsDeps, "store" | "companyId">): (project: string) => Promise<unknown> {
  return async (project) => {
    const row = await readRow({ ...deps, now: () => 0 }, project);
    // A row that does not read gives the defaults, still cut to the company's cap (a damaged row never lifts a run above the lock).
    return effectiveSetupAgentLimits(row === "none" || row === "unreadable" ? {} : row.limits, await readSetupLimitLock(deps));
  };
}

/** The stored form of a setting: only the limits it names, as plain numbers. */
const settingJson = (setting: SetupAgentLimitSetting): Record<string, number> => Object.fromEntries(SETUP_AGENT_LIMIT_NAMES.filter((name) => setting[name] !== undefined).map((name) => [name, setting[name]!]));

const sameSetting = (left: SetupAgentLimitSetting, right: SetupAgentLimitSetting): boolean => SETUP_AGENT_LIMIT_NAMES.every((name) => left[name] === right[name]);

/** The audit record of one change: who, which project, why they were allowed, and the numbers before and after (counts only). */
function auditOf(input: { companyId: OrgId; project: string; by: string; basis: string; now: number; body: SetupLimitsBody; before: SetupAgentLimitSetting; revision: number }): AuditEvent {
  return {
    eventId: `setup.limits_changed:${input.companyId}:${input.project}:${input.by}:${input.body.requestId}`, companyId: input.companyId, at: new Date(input.now).toISOString(),
    actor: { type: "person", id: input.by }, action: "setup.limits_changed", subject: { type: "project", id: input.project },
    details: { project: input.project, basis: input.basis, requestId: input.body.requestId, revision: input.revision, before: settingJson(input.before), after: settingJson(input.body.limits) },
  };
}

/** A strict body or the fixed refusal (field names only, never the values). */
function bodyOf(raw: unknown): SetupLimitsBody {
  const parsedBody = SetupLimitsBodySchema.safeParse(raw);
  if (parsedBody.success) return parsedBody.data;
  const issue = parsedBody.error.issues[0];
  throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
}

/** The audit items to commit with the row; a sink that writes elsewhere records the event first (refused in fixed words when it cannot). */
async function stagedAudit(audit: AuditSink, event: AuditEvent): Promise<ReturnType<AuditSink["stage"]>> {
  const staged = audit.stage(event);
  if (staged.length === 0) {
    try { await audit.record(event); } catch { throw agentXError("AUDIT_UNAVAILABLE", SETUP_LIMITS_AUDIT_UNAVAILABLE); }
  }
  return staged;
}

/** Refuses a setting with any value above the company's cap for it. */
function refuseOverCap(limits: SetupAgentLimitSetting, lock: SetupAgentLimitSetting): void {
  for (const name of SETUP_AGENT_LIMIT_NAMES) {
    const wanted = limits[name];
    const cap = lock[name];
    if (wanted !== undefined && cap !== undefined && wanted > cap) throw agentXError("CONFIG_INVALID", `${name}: the company's cap is ${String(cap)}`);
  }
}

/** Whether a new setting lets a run use or spend more than the stored one for any limit (an absent value is Rovara's default). */
const raises = (before: SetupAgentLimitSetting, after: SetupAgentLimitSetting): boolean =>
  SETUP_AGENT_LIMIT_NAMES.some((name) => (after[name] ?? SETUP_AGENT_LIMITS_DEFAULT[name]) > (before[name] ?? SETUP_AGENT_LIMITS_DEFAULT[name]));

/**
 * `PUT .../setup-agent/limits`: the person's whole setting for the project (the caller has already decided they may). Returns the view after the change (or, for a repeat of the same request, as it stands).
 */
export async function putSetupLimits(deps: SetupLimitsDeps, project: string, raw: unknown, by: string, basis: string, audit: AuditSink, webApp = false): Promise<SetupLimitsView> {
  const body = bodyOf(raw);
  const row = await readRow(deps, project);
  if (row === "unreadable") throw agentXError("RUNTIME_UNAVAILABLE", SETUP_LIMITS_UNREADABLE);
  const lock = await readSetupLimitLock(deps);
  // A repeat of a request already made: the row says it was this one. Nothing is written or recorded again.
  if (row !== "none" && row.requestId === body.requestId) {
    if (!sameSetting(row.limits, body.limits)) throw agentXError("IDEMPOTENCY_CONFLICT", SETUP_LIMITS_REPLAY_DIFFERS);
    return await readSetupLimits(deps, project);
  }
  const currentRevision = row === "none" ? 0 : row.revision;
  if (body.expectedRevision !== currentRevision) throw agentXError("CHANGE_STALE", SETUP_LIMITS_STALE);
  // Owner DEC 254zzz91: a change that raises what a run may use or spend is made only from the Rovara website's own client; lowering is allowed from any full-access client.
  const before = row === "none" ? {} : row.limits;
  if (!webApp && raises(before, body.limits)) throw agentXError("FORBIDDEN", ON_THE_WEBSITE_MESSAGE);
  // Never above the company's cap (a lock only lowers; the page keeps its boxes below it, and the server holds the line).
  refuseOverCap(body.limits, lock);
  const revision = currentRevision + 1;
  const now = deps.now();
  const event = auditOf({ companyId: deps.companyId, project, by, basis, now, body, before: row === "none" ? {} : row.limits, revision });
  const staged = await stagedAudit(audit, event);
  const result = await deps.store.transact([
    {
      kind: "put",
      item: { ...setupLimitsKey(deps.companyId, project), entityType: SETUP_LIMITS_ENTITY, orgId: deps.companyId, project, revision, limits: settingJson(body.limits), requestId: body.requestId, updatedAt: new Date(now).toISOString(), updatedBy: by },
      condition: row === "none" ? when.absent() : when.eq("revision", row.revision),
    },
    ...staged,
  ]);
  if (!result.applied) throw agentXError("CHANGE_STALE", SETUP_LIMITS_STALE);
  return await readSetupLimits(deps, project);
}

