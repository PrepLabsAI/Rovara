// M4a: Code owns PROJECT_SETTINGS. The engine reads these rows only through PolicySource.
import { randomUUID } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  AgentXError, AgentXNameSchema, IMPLICIT_COMPANY_ID, OrgIdSchema, OrgRoleSchema, PolicyRowsSchema, POLICY_FIELDS, PROJECT_CATALOG_PK, agentXError, projectCatalogKey, companyScoped, policyFieldPageOnly,
  canonicalJson, companyLog, orgProjectCatalogKey, orgProjectCatalogPk, orgSettingsKey, projectRevisionKey, createRowsPolicySource, withPolicyHookValues, type HostedPolicyHookSettings, type PolicySource, type PolicyRows, type ResolvedPolicy,
} from "@agentx/contracts";
import { freshStepUp } from "../core-host/step-up.js";
import { createPolicyHookClient, policyHookValuesAsker, type PolicyHookClientOptions } from "../core/policy-hook/index.js";
import { createHostedPolicyHookClient } from "../core/policy-hook/hosted.js";
import { projectGrant } from "./admin-actions.js";
import { Membership, boundedCompanyReads, membershipKey, ownPartitionRow, recordInCompany, resolveCompany } from "./company-check.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./developer-routes.js";
import type { AdaptedHttpRequest } from "./lambda.js";

export type ProjectSettingsHook = Omit<PolicyHookClientOptions, "now" | "randomId" | "log" | "settings"> & { settings: PolicyHookClientOptions["settings"] | HostedPolicyHookSettings };
const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
const settingsSchema = z.object({
  companyId: OrgIdSchema, projectName: AgentXNameSchema, preset: z.enum(["lightweight", "balanced", "careful"]).optional(),
  overrides: z.unknown(), revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), updatedAt: z.iso.datetime(), updatedBy: z.string().min(1).max(256),
}).refine((row) => PolicyRowsSchema.safeParse({ project: row.overrides }).success);
type SettingsRow = Omit<z.infer<typeof settingsSchema>, "overrides"> & { overrides: NonNullable<PolicyRows["project"]> };
const requestSchema = z.object({ expectedRevision: revisionSchema, preset: z.enum(["lightweight", "balanced", "careful"]).optional(), overrides: z.unknown().optional() }).strict()
  .refine((input) => input.preset !== undefined || input.overrides !== undefined)
  .refine((input) => input.overrides === undefined || PolicyRowsSchema.safeParse({ project: input.overrides }).success);

export const projectSettingsKey = (companyId: string, projectName: string) => ({
  pk: companyScoped(OrgIdSchema.parse(companyId), `PROJECT_SETTINGS#${AgentXNameSchema.parse(projectName)}`), sk: "META",
});
const rowsOf = (row: SettingsRow | undefined): PolicyRows => row === undefined ? {} : { ...(row.preset === undefined ? {} : { preset: row.preset }), project: row.overrides };
/** Fixed words (no field, no value): a cost or approval setting is changed on the page, right after a fresh step-up. */
/** L2-5 (b): a company owner or admin who is not one of the project's administrators may change only the project's per-task spending limit. Fixed words. */
export const COMPANY_ADMIN_BUDGET_ONLY = "Company owners and admins can change only this project's per-task spending limit here. Other project settings need one of the project's admins.";
export const SETTINGS_CHANGE_ON_THE_PAGE = "Cost and approval settings are changed on the project's settings page, right after you confirm it's you on the sign-in page: a tool that only holds an API token cannot change them. Confirm it's you, then try again within a few minutes.";
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "policy_unavailable");

/** Adapter-issued scope, after caller/project authorization. One reader, no fallback or cross-company cache.
 * `snapshot` records metadata from the same read that resolved policy; it is not another policy reader.
 */
export function createProjectSettingsPolicySource(
  deps: Pick<DeveloperRouteDependencies, "documentClient" | "tableName" | "now">,
  target: { companyId: string; projectName: string }, hook?: ProjectSettingsHook,
) {
  const key = projectSettingsKey(target.companyId, target.projectName);
  const scope = Object.freeze({ key: `${target.companyId}/${target.projectName}` });
  let snapshot: SettingsRow | undefined;
  let proposed: SettingsRow | undefined;
  // The earliest expiry (ms) of any rules-service answer used by a resolve of this source; undefined when none was asked or answered.
  let answerExpiresAt: number | undefined;
  const source = createRowsPolicySource(async (asked) => {
    if (asked.key !== scope.key) return undefined;
    if (proposed === undefined) {
      const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: unknown };
      snapshot = undefined;
      if (response.Item !== undefined) {
        const parsed = settingsSchema.safeParse(response.Item);
        if (!parsed.success || parsed.data.companyId !== target.companyId || parsed.data.projectName !== target.projectName) throw unavailable();
        snapshot = parsed.data as SettingsRow;
      }
    }
    return { scope: asked, rows: rowsOf(proposed ?? snapshot) };
  });
  // Per-operation wrapper: no stale/grace answer may authorize a settings write after a hook failure.
  let policy: PolicySource = source;
  if (hook !== undefined) {
    try {
      const client = "jwks" in hook.settings
        ? createHostedPolicyHookClient(hook.settings, hook.install, { ...hook, now: deps.now })
        : createPolicyHookClient({ ...hook, settings: hook.settings, now: deps.now });
      const ask = policyHookValuesAsker(client);
      const noting: typeof ask = async (companyId, projectName) => {
        const answer = await ask(companyId, projectName);
        if (answer !== undefined && Number.isFinite(answer.expiresAt)) answerExpiresAt = answerExpiresAt === undefined ? answer.expiresAt : Math.min(answerExpiresAt, answer.expiresAt);
        return answer;
      };
      policy = withPolicyHookValues(source, noting, { scopeOf: (asked) => asked.key === scope.key ? target : undefined, now: deps.now, graceMs: 0 });
    } catch { throw unavailable(); }
  }
  return { source: policy, scope, snapshot: () => snapshot, answerExpiresAt: () => answerExpiresAt, propose: (row: SettingsRow) => { proposed = row; } };
}

/**
 * L2-5 (b): the core engine's reader of a project's own per-task limit (`model_budget_usd`), in micros, rounded down; undefined when the resolved value is none (null).
 * It resolves exactly as the settings page does: the project's stored choice through the same rows reader, then the company's rules service when the install has one (`hook`, read
 * each time, no grace), so the limit enforced is the limit the page shows (a company limit lowers a preset's "none" and an older, higher override). A row that does not read, a
 * rules service that does not answer, or a value that is not a non-negative number throws (the caller refuses). `hook` is required (pass `undefined` explicitly only where the
 * host has no rules-service signer), so a caller cannot drop the company's limit by leaving it out.
 */
export function projectTaskCapReader(deps: Pick<DeveloperRouteDependencies, "documentClient" | "tableName" | "now">, hook: (() => ProjectSettingsHook | undefined) | undefined): (companyId: string, project: string) => Promise<number | undefined> {
  return async (companyId, project) => {
    const policy = createProjectSettingsPolicySource(deps, { companyId, projectName: project }, hook?.());
    const value = (await policy.source.resolve(policy.scope, {})).values["model_budget_usd"]?.value;
    if (value === null) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw unavailable();
    // A limit above any install cap (installs cap a task at $1,000 at most) lowers nothing: kept whole, never wrapped past the safe integer range.
    if (value >= 1_000_000) return Number.MAX_SAFE_INTEGER;
    return Math.floor(Math.round(value * 1e9) / 1e3);
  };
}

/** The page's values, one per field, in the words the page shows. The project page and the company admin view both use this one function. */
function displayValues(resolved: ResolvedPolicy) {
  return Object.fromEntries(Object.entries(resolved.values).map(([field, entry]) => [field, { ...entry,
    origin: entry.origin === "company_minimum" ? "company minimum" : entry.origin === "company_limit" ? "company limit" : entry.origin.replaceAll("_", " "),
  }]));
}
/** Every field a company bound changed from the stored choice, with both values. A project that never set a budget is not listed under a company limit: a budget with no value hands that
 * decision to the company's limit, as the presets always have. An explicit `null` is listed (it asked for no limit). */
function clampedOf(resolved: ResolvedPolicy, stored: ResolvedPolicy, overrides: object) {
  return POLICY_FIELDS.flatMap((field) => {
    const applied = resolved.values[field.id]!;
    const chosen = stored.values[field.id]!.value;
    const kind = applied.companyBound?.kind;
    if (applied.clampedBy === undefined || kind === undefined) return [];
    if (chosen === null && kind === "limit" && !Object.hasOwn(overrides, field.id)) return [];
    return [{ field: field.id, bound: kind, chosen, applied: applied.value, notice: kind === "minimum" ? "raised to your company's minimum" : "lowered to your company's limit" }];
  });
}
function responseOf(row: SettingsRow | undefined, resolved: ResolvedPolicy, stored: ResolvedPolicy) {
  return {
    preset: row?.preset ?? null, overrides: row?.overrides ?? {}, revision: row?.revision ?? 0,
    updatedAt: row?.updatedAt ?? null, updatedBy: row?.updatedBy ?? null, resolved,
    values: displayValues(resolved), clamped: clampedOf(resolved, stored, row?.overrides ?? {}),
  };
}
/** The stored choice (preset and overrides) resolved with NO company bound, so the effect of a bound can be shown and a bound cannot hide a change. */
const storedResolution = (scope: { key: string }, value: SettingsRow | undefined) => createRowsPolicySource(async (asked) => ({ scope: asked, rows: rowsOf(value) })).resolve(scope, {});
/** One project's settings as the page shows them: the stored row, the answer under the company's bounds, and the stored choice before any bound. Throws `policy_unavailable`. */
async function settingsView(policy: ReturnType<typeof createProjectSettingsPolicySource>) {
  let resolved: ResolvedPolicy;
  try { resolved = await policy.source.resolve(policy.scope, {}); }
  catch { throw unavailable(); }
  const row = policy.snapshot();
  return { row, resolved, stored: await storedResolution(policy.scope, row) };
}

// ---- Where a company's projects live (shared by the settings page and the S3 compliance list). ----
type Sender = { send(command: unknown): Promise<unknown> };
const catalogFlag = z.object({ verifiedAt: z.iso.datetime(), count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), runId: z.string().min(1).max(100) });
const positiveRevision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** A catalog row or selected revision that does not read as this company's: fixed words, and the one drift event under only the caller's company. */
function catalogDrift(companyId: string): never {
  companyLog(companyId, (line) => console.warn(JSON.stringify(line)))({ event: "project_catalog.index_drift" });
  throw agentXError("RUNTIME_UNAVAILABLE", "settings unavailable");
}

/** A named company's projects live only in its own partition (ORG#<company>#PROJECT_CATALOG and ORG#<company>#PROJECT#<name> REV# rows): that partition is authoritative and is read
 * without any flag. Only the implicit company (Code's legacy single-company data, D1) may still have its projects in the install-wide shared catalog; it reads its partition once the
 * controller has verified and marked it (PROJECT_CATALOG_INDEX), and the shared rows before that. */
async function readsOwnPartition(client: Sender, tableName: string, companyId: string): Promise<boolean> {
  if (companyId !== IMPLICIT_COMPANY_ID) return true;
  const flag = await client.send(new GetCommand({ TableName: tableName, Key: orgSettingsKey(companyId, "PROJECT_CATALOG_INDEX"), ConsistentRead: true })) as { Item?: unknown };
  if (flag.Item !== undefined && !catalogFlag.safeParse(flag.Item).success) throw agentXError("RUNTIME_UNAVAILABLE", "settings unavailable");
  return flag.Item !== undefined;
}

/** The company's own catalog row for one name, as stored (undefined: the company has no project of that name). */
async function readCatalogRow(client: Sender, tableName: string, companyId: string, name: string): Promise<Record<string, unknown> | undefined> {
  const response = await client.send(new GetCommand({ TableName: tableName, Key: orgProjectCatalogKey(companyId, name), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  return response.Item;
}

/** The name and selected revision a catalog row of the company's own partition points at, or undefined when the row is not a well-formed pointer of THIS company. */
function catalogPointer(item: Record<string, unknown>, companyId: string): { name: string; revision: number } | undefined {
  const name = typeof item["sk"] === "string" ? AgentXNameSchema.safeParse(item["sk"].slice("PROJECT#".length)) : undefined;
  const latest = positiveRevision.safeParse(item["latestRevision"]);
  if (name?.success !== true || item["pk"] !== orgProjectCatalogPk(companyId) || item["sk"] !== `PROJECT#${name.data}`
    || item["entityType"] !== "PROJECT_CATALOG" || !ownPartitionRow(item, companyId) || (Object.hasOwn(item, "name") && item["name"] !== name.data)
    || !latest.success) return undefined;
  return { name: name.data, revision: latest.data };
}

/** Whether the revision a catalog row selects is this company's project of that name at that revision, in the same partition. */
async function selectedRevisionHolds(client: Sender, tableName: string, companyId: string, name: string, revision: number): Promise<boolean> {
  const key = projectRevisionKey(companyId, name, revision);
  const response = await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
  const row = response.Item;
  // A setup approval moves the catalog onto its candidate revision and leaves `candidate: true` on that row (setup-agent/apply.ts), as the engine's own reader accepts.
  const definition = row?.["definition"] as { name?: unknown; revision?: unknown } | null | undefined;
  return row !== undefined && row["pk"] === key.pk && row["sk"] === key.sk && row["entityType"] === "PROJECT" && ownPartitionRow(row, companyId)
    && typeof definition === "object" && definition !== null && definition.name === name && definition.revision === revision;
}

/** The person's grant on a project of a company that keeps its projects in its own partition. The grant row is the broker's (`MEMBER#<person>` / `PROJECT#<id>`, written without a
 * company by registration and the core backfill); the project id is globally unique and was just proven to be this company's, so the row is this company's grant unless it names
 * another company (or a malformed one), which is refused. Rows of the implicit company's legacy path keep `projectGrant`'s stored-company rule.
 * INVARIANT this relies on: project ids are globally unique (registration's conditional write of the shared catalog key; L2-1 keeps company-created ids unique with a random
 * suffix). If ids ever stop being unique across companies, grant rows must carry their company and this exception must go. */
async function partitionProjectGrant(client: Sender, tableName: string, project: string, personId: string, companyId: string): Promise<{ role: "developer" | "administrator" } | undefined> {
  const key = { pk: `MEMBER#${personId}`, sk: `PROJECT#${project}` };
  const response = await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
  const row = response.Item;
  if (row === undefined || row["pk"] !== key.pk || row["sk"] !== key.sk || !ownPartitionRow(row, companyId) || (Object.hasOwn(row, "projectName") && row["projectName"] !== project)) return undefined;
  const role = row["role"];
  return role === "developer" || role === "administrator" ? { role } : undefined;
}

/** The caller's LIVE role in `companyId` (their membership row in the sign-in table, read now); undefined when it does not read, names another company or person, or was revoked. */
async function liveCompanyRole(client: Sender, signInTableName: string, personId: string, companyId: string): Promise<string | undefined> {
  const response = await client.send(new GetCommand({ TableName: signInTableName, Key: membershipKey(personId), ConsistentRead: true })) as { Item?: unknown };
  const member = MembershipRole.safeParse(response.Item);
  if (!member.success || member.data.personId !== personId || member.data.companyId !== companyId || member.data.revokedAt !== undefined) return undefined;
  const role = OrgRoleSchema.safeParse(member.data.role);
  return role.success ? role.data : undefined;
}

/** L2-5 (b): whether a request changes nothing but `model_budget_usd`: the same preset (or none sent), and every other override present and equal exactly as stored. */
function onlyBudgetChanges(current: SettingsRow | undefined, input: z.infer<typeof requestSchema>): boolean {
  if (input.preset !== undefined && input.preset !== current?.preset) return false;
  if (input.overrides === undefined) return true;
  const before = (current?.overrides ?? {}) as Record<string, unknown>;
  const after = input.overrides as Record<string, unknown>;
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (field === "model_budget_usd") continue;
    if (Object.hasOwn(before, field) !== Object.hasOwn(after, field) || canonicalJson(before[field]) !== canonicalJson(after[field])) return false;
  }
  return true;
}

async function checkedSettingsRoute(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, encodedName: string) {
  const budget = boundedCompanyReads(deps.documentClient);
  const client = budget.client;
  let projectName: string;
  try { projectName = AgentXNameSchema.parse(decodeURIComponent(encodedName)); }
  catch { throw agentXError("NOT_FOUND", "project not found"); }
  // Settings always require live membership, including installs that have not enabled other R4 routes.
  const companyId = await budget.read(() => resolveCompany(deps.companies ?? deps.developer.companies, caller.developerId));
  if (companyId === undefined) throw agentXError("AUTH_REQUIRED", "company membership required");
  // The project must be this company's, read from where the company's projects live (the same rule as the S3 compliance list): a named company's own partition (its catalog
  // pointer and the selected revision), the implicit company's partition once it is marked, else the implicit company's legacy shared rows. Another company's project, an
  // unknown one and a shared-only row of a named company are one answer: "project not found".
  const partition = await readsOwnPartition(client, deps.tableName, companyId);
  if (partition) {
    const pointer = await readCatalogRow(client, deps.tableName, companyId, projectName);
    if (pointer === undefined) throw agentXError("NOT_FOUND", "project not found");
    const selected = catalogPointer(pointer, companyId);
    if (selected === undefined || selected.name !== projectName || !await selectedRevisionHolds(client, deps.tableName, companyId, selected.name, selected.revision)) catalogDrift(companyId);
  } else {
    const project = await client.send(new QueryCommand({ TableName: deps.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :rev)", ExpressionAttributeValues: { ":pk": `PROJECT#${projectName}`, ":rev": "REV#" },
      ConsistentRead: true, ScanIndexForward: false, Limit: 1,
    })) as { Items?: unknown[] };
    const projectRow = project.Items?.[0];
    if (projectRow === undefined || !recordInCompany(projectRow, companyId)) throw agentXError("NOT_FOUND", "project not found");
  }
  // Who may change (L2-5 b, DEC 254n's rule as #839's lifecycleAccess): the project's administrator changes any setting; a live company owner or admin who is not one may change
  // only the per-task spending limit (checked below, once the body and the stored row are read); anyone else is refused before the body is read.
  let basis: "project-admin" | "company-owner" | "company-admin" | undefined;
  if (request.method === "PUT") {
    const grant = partition
      ? await partitionProjectGrant(client, deps.tableName, projectName, caller.developerId, companyId)
      : await projectGrant({ documentClient: client, tableName: deps.tableName }, projectName, caller.developerId, companyId);
    if (grant?.role === "administrator") basis = "project-admin";
    else {
      const role = await liveCompanyRole(client, deps.developer.signInTableName, caller.developerId, companyId);
      if (role === "owner") basis = "company-owner";
      else if (role === "admin") basis = "company-admin";
      else throw agentXError("FORBIDDEN", "project administrator required");
    }
  }
  let input: z.infer<typeof requestSchema> | undefined;
  if (request.method === "PUT") {
    try {
      if (Buffer.byteLength(request.body ?? "", "utf8") > 16_384) throw new Error();
      input = requestSchema.parse(JSON.parse(request.body ?? ""));
    } catch { throw agentXError("CONFIG_INVALID", "invalid settings request"); }
  }
  const policy = createProjectSettingsPolicySource({ ...deps, documentClient: client }, { companyId, projectName }, deps.policyHook ?? deps.developer.policyHook);
  const view = await settingsView(policy);
  const { row: current, resolved: before, stored: storedBefore } = view;
  if (input === undefined) { budget.check(); return responseOf(current, before, storedBefore); }
  if (input.expectedRevision !== (current?.revision ?? 0)) throw agentXError("PROJECT_REVISION_MISMATCH", "settings revision conflict");
  if (basis !== "project-admin" && !onlyBudgetChanges(current, input)) throw agentXError("FORBIDDEN", COMPANY_ADMIN_BUDGET_ONLY);
  const preset = input.preset ?? current?.preset;
  const row: SettingsRow = { companyId, projectName, ...(preset === undefined ? {} : { preset }),
    overrides: (input.overrides ?? current?.overrides ?? {}) as SettingsRow["overrides"], revision: input.expectedRevision + 1,
    updatedAt: new Date(deps.now()).toISOString(), updatedBy: caller.developerId };
  // M4a slice 2: a change to a cost or approval field needs a fresh step-up. The STORED choice is compared (preset and overrides, before any company bound), so a company minimum that
  // hides the effect today cannot be used to change what would show when the minimum is lifted. A repeat of what is stored changes nothing and needs none.
  const storedAfter = await storedResolution(policy.scope, row);
  // The chosen preset is itself a cost and approval choice: an override that pins preset_level can hide a preset change in the resolved values, so it is compared directly too.
  const pageOnlyChange = current?.preset !== row.preset || POLICY_FIELDS.some((field) => policyFieldPageOnly(field.id)
    && (storedBefore.values[field.id]!.value !== storedAfter.values[field.id]!.value
      || Object.hasOwn(current?.overrides ?? {}, field.id) !== Object.hasOwn(row.overrides, field.id)));
  if (pageOnlyChange) {
    const window = deps.developer.stepUpWindowSeconds;
    await freshStepUp(caller, window === undefined ? undefined : () => window(companyId), deps.now(), SETTINGS_CHANGE_ON_THE_PAGE);
  }
  policy.propose(row);
  let after: ResolvedPolicy;
  try { after = await policy.source.resolve(policy.scope, {}); }
  catch { throw unavailable(); }
  // M4a slice 4 (DEC 249a.3): a value that came from a preset (the chosen preset, or what a `preset_level` override hands to other fields) is clamped to the company's bound and the
  // response says so (`clamped`). Only an explicit override that breaks a bound is refused, and only when this request adds it or changes it: an override stored before the bound
  // existed is clamped like the rest and never blocks an unrelated change. An explicit `null` budget cannot remove a company limit.
  const unbounded = storedAfter;
  for (const field of POLICY_FIELDS) {
    const stated = Object.hasOwn(row.overrides, field.id) && (!Object.hasOwn(current?.overrides ?? {}, field.id) || current?.overrides[field.id] !== row.overrides[field.id]);
    const value = unbounded.values[field.id]!.value;
    const bounded = after.values[field.id]!;
    if (stated && bounded.clampedBy !== undefined && bounded.companyBound !== undefined && value !== bounded.value) throw agentXError("FORBIDDEN", `${field.id}: company ${bounded.companyBound.kind} cannot be crossed`);
  }
  // The audit row records what applies (`before`/`after`) and, where a company bound hides the person's choice, the choice itself (`chosenBefore`/`chosenAfter`), so a change of the
  // stored choice leaves a trace even when the bound makes it look like nothing changed.
  const changes = POLICY_FIELDS.filter((field) => before.values[field.id]!.value !== after.values[field.id]!.value
    || storedBefore.values[field.id]!.value !== storedAfter.values[field.id]!.value
    || current?.overrides[field.id] !== row.overrides[field.id]
    || field.id === "preset_level" && current?.preset !== row.preset)
    .map((field) => {
      const [chosenBefore, chosenAfter] = [storedBefore.values[field.id]!.value, storedAfter.values[field.id]!.value];
      const [appliedBefore, appliedAfter] = [before.values[field.id]!.value, after.values[field.id]!.value];
      return { field: field.id, before: appliedBefore, after: appliedAfter, ...(chosenBefore !== appliedBefore || chosenAfter !== appliedAfter ? { chosenBefore, chosenAfter } : {}) };
    });
  // A pinned preset_level override hides a preset change from every resolved value, so the event names the presets themselves in that case.
  const presetNamed = current?.preset !== row.preset && storedBefore.values["preset_level"]!.value === storedAfter.values["preset_level"]!.value
    ? { presetBefore: current?.preset ?? null, presetAfter: row.preset ?? null } : {};
  budget.check();
  try {
    // One atomic write: a losing revision or failed audit leaves both records untouched.
    await client.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: deps.tableName, Item: { ...projectSettingsKey(companyId, projectName), entityType: "PROJECT_SETTINGS", ...row },
        ConditionExpression: input.expectedRevision === 0 ? "attribute_not_exists(pk)" : "#revision = :expected",
        ...(input.expectedRevision === 0 ? {} : { ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":expected": input.expectedRevision } }) } },
      { Put: { TableName: deps.tableName, Item: { pk: companyScoped(companyId, "COMPANY_LOG"), sk: `${row.updatedAt}#${randomUUID()}`, entityType: "COMPANY_LOG",
        event: "project_settings_changed", companyId, personId: caller.developerId, projectName, changes, revision: row.revision, ...presetNamed, ...(basis === "project-admin" ? {} : { basis }) }, ConditionExpression: "attribute_not_exists(pk)" } },
    ] }));
  } catch (error) {
    const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> } | undefined)?.CancellationReasons;
    if (reasons?.[0]?.Code === "ConditionalCheckFailed") throw agentXError("PROJECT_REVISION_MISMATCH", "settings revision conflict");
    throw agentXError("RUNTIME_UNAVAILABLE", "settings unavailable");
  }
  return responseOf(row, after, storedAfter);
}

/** Fixed public failures; SDK/parser causes never leave this route. */
export async function projectSettingsRoute(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, encodedName: string) {
  try { return await checkedSettingsRoute(deps, caller, request, encodedName); }
  catch (error) {
    if (error instanceof AgentXError) throw error;
    throw agentXError("RUNTIME_UNAVAILABLE", "settings unavailable");
  }
}

// ---- M4a slice 3 (TE-D8): the company admin's view of every project against the company's bounds. Read-only. ----
const COMPLIANCE_LIMIT_DEFAULT = 20;
const COMPLIANCE_LIMIT_MAX = 50;
/** One call looks at no more catalog names than this, whatever other companies hold, and ends with a cursor when it stops early. */
const COMPLIANCE_EXAMINE_MAX = 200;
const COMPLIANCE_CATALOG_PAGE = 50;
const COMPLIANCE_READS_AT_ONCE = 8;
const COMPLIANCE_HOOK_AT_ONCE = 4;
/** The cursor's count of already-looked-at catalog entries after the last returned project (re-read, not re-checked, on the next call). */
const COMPLIANCE_SKIP_MAX = 1000;
/** No new row starts after this long (the company read budget is 10 s and one rules-service answer may take 5 s), so a slow rules service ends the page early instead of failing it. */
const COMPLIANCE_ROW_DEADLINE_MS = 4000;
const invalidCompliance = () => agentXError("CONFIG_INVALID", "invalid settings compliance request");
const MembershipRole = Membership.extend({ role: z.string().max(40) });

async function inBatches<T, R>(items: readonly T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const index = next++; out[index] = await work(items[index]!); }
  }));
  return out;
}

function complianceQuery(url: URL, partition: boolean, companyId: string): { limit: number; base: string | undefined; skip: number; filter: boolean } {
  const names = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if ((key !== "limit" && key !== "cursor" && key !== "filter") || names.has(key)) throw invalidCompliance();
    names.add(key);
  }
  const limitText = url.searchParams.get("limit");
  const limit = limitText === null ? COMPLIANCE_LIMIT_DEFAULT : /^[1-9][0-9]{0,2}$/.test(limitText) ? Number(limitText) : 0;
  if (limit < 1 || limit > COMPLIANCE_LIMIT_MAX) throw invalidCompliance();
  // Company partition (v2): a canonical cursor bound to the caller's company and one of its own catalog names. Legacy shared catalog (v1, implicit company only): a position in the
  // install-wide catalog that never holds another company's name: "<the last name this call returned>~<how many catalog entries after it were already looked at>". Either way the name
  // must be one of THIS company's projects (checked below, with the same refusal for a foreign or unknown name), so a made-up cursor learns nothing beyond a count.
  const cursorText = url.searchParams.get("cursor");
  let base: string | undefined; let skip = 0;
  if (cursorText !== null) {
    if (partition) {
      try {
        if (cursorText.length > 512 || !/^c2\.[A-Za-z0-9_-]+$/.test(cursorText)) throw invalidCompliance();
        const encoded = cursorText.slice(3), bytes = Buffer.from(encoded, "base64url");
        if (bytes.toString("base64url") !== encoded) throw invalidCompliance();
        const cursor = z.object({ v: z.literal(2), companyId: OrgIdSchema, after: AgentXNameSchema }).strict().parse(JSON.parse(bytes.toString("utf8")));
        if (cursor.companyId !== companyId || complianceCursor(cursor.companyId, cursor.after) !== cursorText) throw invalidCompliance();
        base = cursor.after;
      } catch { throw invalidCompliance(); }
    } else {
      const parts = /^([a-z][a-z0-9-]{0,62})?~([0-9]{1,4})$/.exec(cursorText);
      if (parts === null || Number(parts[2]) > COMPLIANCE_SKIP_MAX) throw invalidCompliance();
      base = parts[1]; skip = Number(parts[2]);
    }
  }
  const filterText = url.searchParams.get("filter");
  if (filterText !== null && filterText !== "below_company_bound") throw invalidCompliance();
  return { limit, base, skip, filter: filterText !== null };
}

const complianceCursor = (companyId: string, after: string) => "c2." + Buffer.from(canonicalJson({ v: 2, companyId, after })).toString("base64url");
async function checkedComplianceRoute(deps: DeveloperRouteDependencies, caller: DeveloperCaller, url: URL) {
  const startedAt = deps.now();
  // The budget and the row deadline run on the same clock.
  const budget = boundedCompanyReads(deps.documentClient, deps.now);
  const client = budget.client;
  // Live membership first, then the role: a member of the company who is not an administrator learns nothing but that.
  const companyId = await budget.read(() => resolveCompany(deps.companies ?? deps.developer.companies, caller.developerId));
  if (companyId === undefined) throw agentXError("AUTH_REQUIRED", "company membership required");
  let role: string;
  try {
    const response = await client.send(new GetCommand({ TableName: deps.developer.signInTableName, Key: membershipKey(caller.developerId), ConsistentRead: true })) as { Item?: unknown };
    const member = MembershipRole.parse(response.Item);
    if (member.personId !== caller.developerId || member.companyId !== companyId || member.revokedAt !== undefined) throw new Error("membership unavailable");
    role = member.role;
  } catch { throw agentXError("AUTH_REQUIRED", "company membership required"); }
  const checkedRole = OrgRoleSchema.safeParse(role);
  if (!checkedRole.success || (checkedRole.data !== "admin" && checkedRole.data !== "owner")) throw agentXError("FORBIDDEN", "company administrator required");
  // Where the company's projects live: see readsOwnPartition.
  const partition = await readsOwnPartition(client, deps.tableName, companyId);
  const query = complianceQuery(url, partition, companyId);
  if (query.base !== undefined && partition) {
    try {
      if (await readCatalogRow(client, deps.tableName, companyId, query.base) === undefined) throw invalidCompliance();
    } catch { throw invalidCompliance(); }
  }
  if (query.base !== undefined && !partition) {
    const own = await client.send(new QueryCommand({ TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :rev)",
      ExpressionAttributeValues: { ":pk": `PROJECT#${query.base}`, ":rev": "REV#" }, ConsistentRead: true, ScanIndexForward: false, Limit: 1 })) as { Items?: unknown[] };
    if (own.Items?.[0] === undefined || !recordInCompany(own.Items[0], companyId)) throw invalidCompliance();
  }

  // Company partition: every row is this company's by its key; a row naming another company, or a catalog pointer whose selected revision is missing or not a project of that name,
  // is drift and fails closed. Legacy shared catalog (implicit company only): the install's catalog holds every company's names, so each name is kept only if its latest revision belongs
  // to THIS company (the same check the project page makes). The scan position (`base`, `skip`) only ever names a project of this company, or counts entries.
  const names: string[] = [];
  let base = query.base; let skip = query.skip; let toSkip = query.skip; let examined = 0; let exhausted = false;
  let nextCursor: string | null;
  if (partition) {
    const drift = () => catalogDrift(companyId);
    const page = await client.send(new QueryCommand({ TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": orgProjectCatalogPk(companyId), ":prefix": "PROJECT#" }, ConsistentRead: true, Limit: query.limit,
      ...(query.base === undefined ? {} : { ExclusiveStartKey: orgProjectCatalogKey(companyId, query.base) }) })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    const candidates = (page.Items ?? []).map((item) => catalogPointer(item, companyId) ?? drift());
    const selected = await inBatches(candidates, COMPLIANCE_READS_AT_ONCE, async ({ name, revision }) => selectedRevisionHolds(client, deps.tableName, companyId, name, revision));
    if (selected.some(own => !own)) drift();
    names.push(...candidates.map(({ name }) => name));
    if (page.LastEvaluatedKey !== undefined && names.length === 0) drift();
    nextCursor = page.LastEvaluatedKey === undefined ? null : complianceCursor(companyId, names[names.length - 1]!);
  } else {
    let startKey: Record<string, unknown> | undefined = base === undefined ? undefined : projectCatalogKey(base);
    while (names.length < query.limit && examined < COMPLIANCE_EXAMINE_MAX) {
      const page = await client.send(new QueryCommand({ TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": PROJECT_CATALOG_PK, ":prefix": "PROJECT#" }, ConsistentRead: true,
        Limit: toSkip > 0 ? COMPLIANCE_CATALOG_PAGE : Math.min(COMPLIANCE_CATALOG_PAGE, COMPLIANCE_EXAMINE_MAX - examined),
        ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }) })) as { Items?: Array<{ sk?: unknown }>; LastEvaluatedKey?: Record<string, unknown> };
      startKey = page.LastEvaluatedKey;
      const dropped = Math.min(toSkip, (page.Items ?? []).length);
      toSkip -= dropped;
      const items = (page.Items ?? []).slice(dropped);
      // A catalog name that is not a valid project name is corrupt data: stop (fixed words) rather than skip it and cut the list silently.
      const candidates = items.map((item) => {
        const parsed = typeof item.sk === "string" && item.sk.startsWith("PROJECT#") ? AgentXNameSchema.safeParse(item.sk.slice("PROJECT#".length)) : undefined;
        if (parsed?.success !== true) throw agentXError("RUNTIME_UNAVAILABLE", "settings unavailable");
        return parsed.data;
      });
      const inCompany = await inBatches(candidates, COMPLIANCE_READS_AT_ONCE, async (name) => {
        const latest = await client.send(new QueryCommand({ TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :rev)",
          ExpressionAttributeValues: { ":pk": `PROJECT#${name}`, ":rev": "REV#" }, ConsistentRead: true, ScanIndexForward: false, Limit: 1 })) as { Items?: unknown[] };
        return latest.Items?.[0] !== undefined && recordInCompany(latest.Items[0], companyId);
      });
      let stoppedAt: number | undefined;
      for (let index = 0; index < candidates.length; index++) {
        examined++;
        if (inCompany[index]) { names.push(candidates[index]!); base = candidates[index]!; skip = 0; } else skip++;
        if (names.length === query.limit) { stoppedAt = index; break; }
      }
      if (startKey === undefined && (stoppedAt === undefined || stoppedAt === candidates.length - 1)) { exhausted = true; break; }
      budget.check();
    }
    if (!exhausted && skip > COMPLIANCE_SKIP_MAX) throw agentXError("CONFIG_INVALID", "company read limit exceeded");
    nextCursor = exhausted ? null : `${base ?? ""}~${skip}`;

  }

  // Each row is the project page's own answer, read through the same source. A row that cannot be read or answered says so; it is never defaulted or dropped. Rows start four at a
  // time and stop starting once the time is nearly used up: the page then ends early with a cursor at the last row done.
  const rowOf = async (projectName: string) => {
    try {
      const policy = createProjectSettingsPolicySource({ ...deps, documentClient: client }, { companyId, projectName }, deps.policyHook ?? deps.developer.policyHook);
      const { row, resolved, stored } = await settingsView(policy);
      const clamped = clampedOf(resolved, stored, row?.overrides ?? {});
      return { project: projectName, status: "resolved" as const, hasSettings: row !== undefined, preset: row?.preset ?? null, revision: row?.revision ?? 0, updatedAt: row?.updatedAt ?? null,
        changedHere: row === undefined ? [] : POLICY_FIELDS.filter((field) => Object.hasOwn(row.overrides, field.id)).map((field) => field.id),
        values: displayValues(resolved), clamped, belowCompanyBound: clamped.length > 0 };
    } catch (error) {
      if (error instanceof AgentXError && error.code !== "RUNTIME_UNAVAILABLE") throw error;
      return { project: projectName, status: "unavailable" as const, reason: "policy_unavailable" as const };
    }
  };
  const rows: Array<Awaited<ReturnType<typeof rowOf>>> = [];
  while (rows.length < names.length) {
    if (rows.length > 0 && deps.now() - startedAt > COMPLIANCE_ROW_DEADLINE_MS) { nextCursor = partition ? complianceCursor(companyId, names[rows.length - 1]!) : `${names[rows.length - 1]!}~0`; break; }
    rows.push(...await Promise.all(names.slice(rows.length, rows.length + COMPLIANCE_HOOK_AT_ONCE).map(rowOf)));
  }
  budget.check();
  return { projects: query.filter ? rows.filter((row) => row.status === "unavailable" || row.belowCompanyBound) : rows, nextCursor };
}

/** GET /v1/dev/company/settings-compliance: fixed public failures, no cause leaves this route. */
export async function projectSettingsComplianceRoute(deps: DeveloperRouteDependencies, caller: DeveloperCaller, url: URL) {
  try { return await checkedComplianceRoute(deps, caller, url); }
  catch (error) {
    if (error instanceof AgentXError) throw error;
    throw agentXError("RUNTIME_UNAVAILABLE", "settings unavailable");
  }
}
