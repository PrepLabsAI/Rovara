// Lane W (contract v0 `client.projects.codeSettings.get` / `.put`): a project's merge rules, read and changed through the developer API.
//
//   GET /v1/dev/client/projects/{project}/code-settings   any person who may use the project
//   PUT /v1/dev/client/projects/{project}/code-settings   the project's administrator or a company administrator; revision-checked
//
// The shape is Code's own `CodeSettings` (allowSelfApproval, mergeMethod, codeReviewers, revision; `CodeSettingsBodySchema` for a change): the one the web app's reader parses and the
// merge core enforces (`CodeSettingsReader`, read by `prepareMerge`/`pressMerge` through `codeSettingsReader` below). Contract v0's proposed shape (requireSecondReviewer, mergeRule,
// protectedPaths) names rules no merge code enforces, so it is not served; the contract is corrected to this shape (see the PR).
//
// Rules:
//   - The record is company-scoped in its key (`CODE_SETTINGS#<company>#<project>`), so two companies with the same project name never share settings; it also names its company,
//     and a record naming another company is refused, never applied.
//   - DEC 254zzz73: no step-up. Any change needs the project's administrator or a company administrator (`mayChange`, read live by the developer API); LOOSENING a rule
//     (self-approval on, a required reviewer off) also needs the Rovara website's own client (DEC 254zzz91).
//   - A stale revision is refused with Code's fixed words; the body is validated at runtime (strict); refusals never echo what was sent.
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  CODE_SETTINGS_STALE_MESSAGE, ON_THE_WEBSITE_MESSAGE, CodeSettingsBodySchema, CodeSettingsSchema, DEFAULT_CODE_SETTINGS, IMPLICIT_COMPANY_ID, agentXError, type CodeSettings, type OrgId,
} from "@agentx/contracts";
import type { CodeSettingsReader } from "../core/merge/seams.js";

export const NOT_A_PROJECT_ADMIN = "only the project's administrators or a company administrator can change its merge rules";
export const CODE_SETTINGS_BODY = "send a requestId, the revision you read, and only allowSelfApproval, mergeMethod or codeReviewers";
export const CODE_SETTINGS_UNREADABLE = "the project's merge rules could not be read";

/** One record per company and project; the company is in the key (an org id, or the implicit company: never a '#'), so two companies' same-named projects never share it. */
export const codeSettingsKey = (companyId: string, project: string) => {
  if (companyId === "" || /[#\s]/u.test(companyId)) throw agentXError("CONFIG_INVALID", "a company id has no '#' or white space");
  return { pk: `CODE_SETTINGS#${companyId}#${project}`, sk: "CODE_SETTINGS" };
};

interface Store { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }

/** The project's settings in this company: the stored ones, or Code's defaults (self-approval off, squash, no reviewers, revision 0) when none were saved. */
export async function readCodeSettings(store: Store, companyId: string, project: string): Promise<CodeSettings> {
  const item = (await store.documentClient.send(new GetCommand({ TableName: store.tableName, Key: codeSettingsKey(companyId, project), ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
  if (item === undefined) return { ...DEFAULT_CODE_SETTINGS };
  const settings = CodeSettingsSchema.safeParse(item["settings"]);
  if (item["companyId"] !== companyId || item["project"] !== project || !settings.success) throw agentXError("RUNTIME_UNAVAILABLE", CODE_SETTINGS_UNREADABLE);
  return settings.data;
}

/** The merge core's settings seam over the same record, so the rules a person saved are the rules a merge is checked against. */
export function codeSettingsReader(store: Store): CodeSettingsReader {
  return { read: (orgId: OrgId, project: string) => readCodeSettings(store, orgId, project) };
}

/**
 * The same settings, for ONE company's runtime (the core's job services): asked about any other company it refuses, so a runtime never reads a settings record outside its own company,
 * whatever company a row it is handed names. A project with no saved settings has Code's defaults (self-approval off, squash, no reviewers).
 */
export function companyCodeSettingsReader(store: Store, companyId: string): CodeSettingsReader {
  return { read: async (orgId: OrgId, project: string) => {
    if (orgId !== companyId) throw agentXError("RUNTIME_UNAVAILABLE", CODE_SETTINGS_UNREADABLE);
    return readCodeSettings(store, companyId, project);
  } };
}

/** Whether `next` is looser than `current`: self-approval turned on, or a required reviewer taken off. */
export function loosens(current: CodeSettings, next: Omit<CodeSettings, "revision">): boolean {
  if (!current.allowSelfApproval && next.allowSelfApproval) return true;
  const kept = new Set(next.codeReviewers.map((name) => name.toLowerCase()));
  return current.codeReviewers.some((name) => !kept.has(name.toLowerCase()));
}

/** A checked change. `mayChange` is the caller's right (project administrator or company administrator), decided by the developer API before any body is read. */
export async function putCodeSettings(store: Store & { now: () => number; log(entry: Record<string, unknown>): void }, input: {
  companyId: string | undefined; project: string; personId: string; clientId: string; mayChange: boolean; webApp?: boolean; body: unknown;
}): Promise<{ settings: CodeSettings }> {
  if (!input.mayChange) throw agentXError("FORBIDDEN", NOT_A_PROJECT_ADMIN);
  const body = CodeSettingsBodySchema.safeParse(input.body);
  if (!body.success) throw agentXError("CONFIG_INVALID", CODE_SETTINGS_BODY);
  const companyId = input.companyId ?? IMPLICIT_COMPANY_ID;
  const current = await readCodeSettings(store, companyId, input.project);
  if (body.data.expectedRevision !== current.revision) throw agentXError("CHANGE_STALE", CODE_SETTINGS_STALE_MESSAGE);
  const next = {
    allowSelfApproval: body.data.allowSelfApproval ?? current.allowSelfApproval,
    mergeMethod: body.data.mergeMethod ?? current.mergeMethod,
    codeReviewers: body.data.codeReviewers ?? current.codeReviewers,
  };
  // Owner DEC 254zzz91: LOOSENING a rule is made only from the Rovara website's own client (never the CLI's or an AI tool's token); tightening and the merge method are not.
  if (loosens(current, next) && input.webApp !== true) throw agentXError("FORBIDDEN", ON_THE_WEBSITE_MESSAGE);
  const settings: CodeSettings = { ...next, revision: current.revision + 1 };
  try {
    await store.documentClient.send(new PutCommand({
      TableName: store.tableName,
      Item: { ...codeSettingsKey(companyId, input.project), entityType: "PROJECT_CODE_SETTINGS", companyId, project: input.project, settings, updatedAt: new Date(store.now()).toISOString(), updatedBy: input.personId },
      ...(current.revision === 0
        ? { ConditionExpression: "attribute_not_exists(pk)" }
        : { ConditionExpression: "#settings.#revision = :revision", ExpressionAttributeNames: { "#settings": "settings", "#revision": "revision" }, ExpressionAttributeValues: { ":revision": current.revision } }),
    }));
  } catch (error) {
    if ((error as { name?: unknown }).name === "ConditionalCheckFailedException") throw agentXError("CHANGE_STALE", CODE_SETTINGS_STALE_MESSAGE);
    throw error;
  }
  store.log({ event: "client.project_code_settings_changed", clientId: input.clientId, by: input.personId, project: input.project, revision: settings.revision, loosened: loosens(current, next) });
  return { settings };
}
