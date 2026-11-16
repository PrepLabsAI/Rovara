// M4a: Code owns PROJECT_SETTINGS. The engine reads these rows only through PolicySource.
import { randomUUID } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  AgentXError, AgentXNameSchema, OrgIdSchema, OrgRoleSchema, PolicyRowsSchema, POLICY_FIELDS, PROJECT_CATALOG_PK, agentXError, projectCatalogKey, companyScoped, policyFieldPageOnly,
  createRowsPolicySource, withPolicyHookValues, type HostedPolicyHookSettings, type PolicySource, type PolicyRows, type ResolvedPolicy,
} from "@agentx/contracts";
import { freshStepUp } from "../core-host/step-up.js";
import { createPolicyHookClient, policyHookValuesAsker, type PolicyHookClientOptions } from "../core/policy-hook/index.js";
import { createHostedPolicyHookClient } from "../core/policy-hook/hosted.js";
import { projectGrant } from "./admin-actions.js";
import { Membership, boundedCompanyReads, membershipKey, recordInCompany, resolveCompany } from "./company-check.js";
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
      policy = withPolicyHookValues(source, policyHookValuesAsker(client), { scopeOf: (asked) => asked.key === scope.key ? target : undefined, now: deps.now, graceMs: 0 });
    } catch { throw unavailable(); }
  }
  return { source: policy, scope, snapshot: () => snapshot, propose: (row: SettingsRow) => { proposed = row; } };
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

async function checkedSettingsRoute(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, encodedName: string) {
  const budget = boundedCompanyReads(deps.documentClient);
  const client = budget.client;
  let projectName: string;
  try { projectName = AgentXNameSchema.parse(decodeURIComponent(encodedName)); }
  catch { throw agentXError("NOT_FOUND", "project not found"); }
  // Settings always require live membership, including installs that have not enabled other R4 routes.
  const companyId = await budget.read(() => resolveCompany(deps.companies ?? deps.developer.companies, caller.developerId));
  if (companyId === undefined) throw agentXError("AUTH_REQUIRED", "company membership required");
  const project = await client.send(new QueryCommand({ TableName: deps.tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :rev)", ExpressionAttributeValues: { ":pk": `PROJECT#${projectName}`, ":rev": "REV#" },
    ConsistentRead: true, ScanIndexForward: false, Limit: 1,
  })) as { Items?: unknown[] };
  const projectRow = project.Items?.[0];
  if (projectRow === undefined || !recordInCompany(projectRow, companyId)) throw agentXError("NOT_FOUND", "project not found");
  if (request.method === "PUT") {
    const grant = await projectGrant({ documentClient: client, tableName: deps.tableName }, projectName, caller.developerId, companyId);
    if (grant?.role !== "administrator") throw agentXError("FORBIDDEN", "project administrator required");
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
        event: "project_settings_changed", companyId, personId: caller.developerId, projectName, changes, revision: row.revision, ...presetNamed }, ConditionExpression: "attribute_not_exists(pk)" } },
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

function complianceQuery(url: URL): { limit: number; base: string | undefined; skip: number; filter: boolean } {
  const names = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if ((key !== "limit" && key !== "cursor" && key !== "filter") || names.has(key)) throw invalidCompliance();
    names.add(key);
  }
  const limitText = url.searchParams.get("limit");
  const limit = limitText === null ? COMPLIANCE_LIMIT_DEFAULT : /^[1-9][0-9]{0,2}$/.test(limitText) ? Number(limitText) : 0;
  if (limit < 1 || limit > COMPLIANCE_LIMIT_MAX) throw invalidCompliance();
  // The cursor is a position in the install-wide catalog that never holds another company's name: "<the last name this call returned>~<how many catalog entries after it were already
  // looked at>". The name must be one of THIS company's projects (checked below, with the same refusal for a foreign or unknown name), so a made-up cursor learns nothing beyond a count.
  const cursorText = url.searchParams.get("cursor");
  let base: string | undefined; let skip = 0;
  if (cursorText !== null) {
    const parts = /^([a-z][a-z0-9-]{0,62})?~([0-9]{1,4})$/.exec(cursorText);
    if (parts === null || Number(parts[2]) > COMPLIANCE_SKIP_MAX) throw invalidCompliance();
    base = parts[1]; skip = Number(parts[2]);
  }
  const filterText = url.searchParams.get("filter");
  if (filterText !== null && filterText !== "below_company_bound") throw invalidCompliance();
  return { limit, base, skip, filter: filterText !== null };
}

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
  const query = complianceQuery(url);
  if (query.base !== undefined) {
    const own = await client.send(new QueryCommand({ TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :rev)",
      ExpressionAttributeValues: { ":pk": `PROJECT#${query.base}`, ":rev": "REV#" }, ConsistentRead: true, ScanIndexForward: false, Limit: 1 })) as { Items?: unknown[] };
    if (own.Items?.[0] === undefined || !recordInCompany(own.Items[0], companyId)) throw invalidCompliance();
  }

  // The install's catalog holds every company's names, so each name is kept only if its latest revision belongs to THIS company (the same check the project page makes).
  // The scan position (`base`, `skip`) only ever names a project of this company, or counts entries; no other company's name is returned.
  const names: string[] = [];
  let base = query.base; let skip = query.skip; let toSkip = query.skip; let examined = 0; let exhausted = false;
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
  let nextCursor: string | null = exhausted ? null : `${base ?? ""}~${skip}`;

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
    if (rows.length > 0 && deps.now() - startedAt > COMPLIANCE_ROW_DEADLINE_MS) { nextCursor = `${names[rows.length - 1]!}~0`; break; }
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
