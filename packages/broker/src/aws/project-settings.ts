// M4a: Code owns PROJECT_SETTINGS. The engine reads these rows only through PolicySource.
import { randomUUID } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  AgentXError, AgentXNameSchema, OrgIdSchema, PolicyRowsSchema, POLICY_FIELDS, agentXError, companyScoped, policyFieldPageOnly,
  createRowsPolicySource, withPolicyHookValues, type PolicySource, type PolicyRows, type ResolvedPolicy,
} from "@agentx/contracts";
import { freshStepUp } from "../core-host/step-up.js";
import { createPolicyHookClient, policyHookValuesAsker, type PolicyHookClientOptions } from "../core/policy-hook/index.js";
import { projectGrant } from "./admin-actions.js";
import { boundedCompanyReads, recordInCompany, resolveCompany } from "./company-check.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./developer-routes.js";
import type { AdaptedHttpRequest } from "./lambda.js";

export type ProjectSettingsHook = Omit<PolicyHookClientOptions, "now" | "randomId" | "log">;
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
      const client = createPolicyHookClient({ ...hook, now: deps.now });
      policy = withPolicyHookValues(source, policyHookValuesAsker(client), { scopeOf: (asked) => asked.key === scope.key ? target : undefined, now: deps.now, graceMs: 0 });
    } catch { throw unavailable(); }
  }
  return { source: policy, scope, snapshot: () => snapshot, propose: (row: SettingsRow) => { proposed = row; } };
}

function responseOf(row: SettingsRow | undefined, resolved: ResolvedPolicy) {
  return {
    preset: row?.preset ?? null, overrides: row?.overrides ?? {}, revision: row?.revision ?? 0,
    updatedAt: row?.updatedAt ?? null, updatedBy: row?.updatedBy ?? null, resolved,
    values: Object.fromEntries(Object.entries(resolved.values).map(([field, entry]) => [field, { ...entry,
      origin: entry.origin === "company_minimum" ? "company minimum" : entry.origin === "company_limit" ? "company limit" : entry.origin.replaceAll("_", " "),
    }])),
  };
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
  let before: ResolvedPolicy;
  try { before = await policy.source.resolve(policy.scope, {}); }
  catch { throw unavailable(); }
  const current = policy.snapshot();
  if (input === undefined) { budget.check(); return responseOf(current, before); }
  if (input.expectedRevision !== (current?.revision ?? 0)) throw agentXError("PROJECT_REVISION_MISMATCH", "settings revision conflict");
  const preset = input.preset ?? current?.preset;
  const row: SettingsRow = { companyId, projectName, ...(preset === undefined ? {} : { preset }),
    overrides: (input.overrides ?? current?.overrides ?? {}) as SettingsRow["overrides"], revision: input.expectedRevision + 1,
    updatedAt: new Date(deps.now()).toISOString(), updatedBy: caller.developerId };
  // M4a slice 2: a change to a cost or approval field needs a fresh step-up. The STORED choice is compared (preset and overrides, before any company bound), so a company minimum that
  // hides the effect today cannot be used to change what would show when the minimum is lifted. A repeat of what is stored changes nothing and needs none.
  const storedRows = (value: SettingsRow | undefined) => createRowsPolicySource(async (scope) => ({ scope, rows: rowsOf(value) })).resolve(policy.scope, {});
  const [storedBefore, storedAfter] = await Promise.all([storedRows(current), storedRows(row)]);
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
  // Resolve the proposed project layers through the same seam; company bounds are applied by the shared clamp above.
  const unbounded = storedAfter;
  for (const field of POLICY_FIELDS) {
    const value = unbounded.values[field.id]!.value;
    const bounded = after.values[field.id]!;
    const explicitlySet = Object.hasOwn(row.overrides, field.id) || input.preset !== undefined;
    if (explicitlySet && bounded.companyBound !== undefined && value !== bounded.value) {
      // Presets have no universal budget; their null delegates to the company's limit. An explicit null cannot remove it.
      if (value === null && bounded.companyBound.kind === "limit" && !Object.hasOwn(row.overrides, field.id)) continue;
      throw agentXError("FORBIDDEN", `${field.id}: company ${bounded.companyBound.kind} cannot be crossed`);
    }
  }
  const changes = POLICY_FIELDS.filter((field) => before.values[field.id]!.value !== after.values[field.id]!.value
    || current?.overrides[field.id] !== row.overrides[field.id]
    || field.id === "preset_level" && current?.preset !== row.preset)
    .map((field) => ({ field: field.id, before: before.values[field.id]!.value, after: after.values[field.id]!.value }));
  budget.check();
  try {
    // One atomic write: a losing revision or failed audit leaves both records untouched.
    await client.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: deps.tableName, Item: { ...projectSettingsKey(companyId, projectName), entityType: "PROJECT_SETTINGS", ...row },
        ConditionExpression: input.expectedRevision === 0 ? "attribute_not_exists(pk)" : "#revision = :expected",
        ...(input.expectedRevision === 0 ? {} : { ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":expected": input.expectedRevision } }) } },
      { Put: { TableName: deps.tableName, Item: { pk: companyScoped(companyId, "COMPANY_LOG"), sk: `${row.updatedAt}#${randomUUID()}`, entityType: "COMPANY_LOG",
        event: "project_settings_changed", companyId, personId: caller.developerId, projectName, changes, revision: row.revision }, ConditionExpression: "attribute_not_exists(pk)" } },
    ] }));
  } catch (error) {
    const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> } | undefined)?.CancellationReasons;
    if (reasons?.[0]?.Code === "ConditionalCheckFailed") throw agentXError("PROJECT_REVISION_MISMATCH", "settings revision conflict");
    throw agentXError("RUNTIME_UNAVAILABLE", "settings unavailable");
  }
  return responseOf(row, after);
}

/** Fixed public failures; SDK/parser causes never leave this route. */
export async function projectSettingsRoute(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, encodedName: string) {
  try { return await checkedSettingsRoute(deps, caller, request, encodedName); }
  catch (error) {
    if (error instanceof AgentXError) throw error;
    throw agentXError("RUNTIME_UNAVAILABLE", "settings unavailable");
  }
}
