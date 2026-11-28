// #1612: move an install's GitHub App installations, its own Slack workspace and that workspace's channel bindings from the built-in company into the install's own company, after
// its projects moved (install-company-move.ts). Operator-run, re-runnable, a preview unless `apply`; every write is conditional, and nothing that names another company is touched.
//   1. GitHub: each installation the operator lists (init and upgrade read them from the GitHub App). One bound to the built-in company moves (moveGithubInstallation, as #1300);
//      one with no binding yet is claimed for the install's company; one bound to it already is left; one bound to another company is a conflict, never moved.
//   2. Channels: each of the install workspace's legacy channel bindings is copied into the company's own partition (the same fields), BEFORE the workspace moves, so a mention never
//      finds the workspace in the company with its channels still in the legacy partition. Legacy rows are kept.
//   3. The workspace: bound to the built-in company (or, before the binding backfill, implicitly so) moves to the install's company (moveSlackWorkspace); with no binding at all it is
//      bound to it; bound to another company is a conflict.
// Reports carry counts and fixed outcomes only.
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { IMPLICIT_COMPANY_ID, OrgIdSchema, SLACK_BINDING_SK_PREFIX, SLACK_CHANNEL, channelBindingPartition } from "@agentx/contracts";
import { CompanySignInStore } from "../developer/company-membership.js";
import { InstallCompanyStore } from "../developer/install-company.js";
import { GithubInstallationBindings, moveGithubInstallation } from "./github-credentials.js";
import { slackChannelBindingKeyFor } from "./slack-company-layout.js";
import { createSlackWorkspaceBindings, moveSlackWorkspace, parseBinding, slackWorkspaceTeam, teamKey } from "./slack-workspace-binding.js";
import type { InstallMoveCounts } from "./install-company-move.js";

export interface InstallConnectionsDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  /** The State table. */
  tableName: string;
  signInTableName: string;
  now?: () => number;
}

export interface InstallConnectionsInput {
  companyId: string;
  /** The install's own Slack workspace (SlackTeamId); absent: no Slack step. */
  slackTeamId?: string;
  /** The GitHub App's installations, as GitHub lists them. */
  installations: ReadonlyArray<{ installationId: number; accountLogin: string }>;
  apply: boolean;
}

export type WorkspaceOutcome = "none" | "existing" | "moved" | "bound" | "conflict";
export interface InstallConnectionsReport {
  companyId: string;
  apply: boolean;
  githubInstallations: InstallMoveCounts;
  slackChannels: InstallMoveCounts;
  slackWorkspace: WorkspaceOutcome;
  /** A read or write failed: nothing after it ran; run the move again. */
  failed: boolean;
}

type Row = Record<string, unknown>;
const BY = "operator.install_move";
const MAX_CHANNELS = 500;
const counts = (): InstallMoveCounts => ({ found: 0, written: 0, existing: 0, conflicts: 0 });
const conditional = (error: unknown) => error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");

export async function moveInstallConnections(deps: InstallConnectionsDependencies, input: InstallConnectionsInput): Promise<InstallConnectionsReport> {
  const companyId = OrgIdSchema.refine((id) => id !== IMPLICIT_COMPANY_ID).parse(input.companyId);
  const result: InstallConnectionsReport = { companyId, apply: input.apply, githubInstallations: counts(), slackChannels: counts(), slackWorkspace: "none", failed: false };
  try {
    const install = new InstallCompanyStore({ company: new CompanySignInStore({ documentClient: deps.documentClient, tableName: deps.signInTableName, now: deps.now ?? Date.now }),
      documentClient: deps.documentClient, tableName: deps.signInTableName, now: deps.now ?? Date.now });
    // Only ever into the install's own company, checked before anything is read or written.
    if (await install.companyId() !== companyId) throw new Error("not the install's company");
    for (const installation of input.installations) await moveInstallation(deps, companyId, installation, input.apply, result.githubInstallations);
    if (input.slackTeamId !== undefined && slackWorkspaceTeam(input.slackTeamId)) {
      await copyChannels(deps, companyId, input.slackTeamId, input.apply, result.slackChannels);
      result.slackWorkspace = await moveWorkspace(deps, companyId, input.slackTeamId, input.apply);
    }
  } catch { result.failed = true; }
  return result;
}

async function moveInstallation(deps: InstallConnectionsDependencies, companyId: string, installation: { installationId: number; accountLogin: string }, apply: boolean, into: InstallMoveCounts): Promise<void> {
  into.found++;
  const binding = await get(deps, { pk: `GITHUB_INSTALLATION#${installation.installationId}`, sk: "BINDING" });
  const owner = binding?.["companyId"];
  if (owner === companyId) { into.existing++; return; }
  if (binding !== undefined && owner !== IMPLICIT_COMPANY_ID) { into.conflicts++; return; }
  if (binding !== undefined) {
    await moveGithubInstallation({ client: deps.documentClient, tableName: deps.tableName, ...(deps.now === undefined ? {} : { now: deps.now }) },
      { installationId: installation.installationId, from: IMPLICIT_COMPANY_ID, to: companyId, by: BY, apply });
    into.written++;
    return;
  }
  // A claim audit row with no binding is an earlier claim's leftover: never claim over it.
  if (await get(deps, { pk: `GITHUB_INSTALLATION#${installation.installationId}`, sk: "AUDIT#CLAIM" }) !== undefined) { into.conflicts++; return; }
  if (apply) {
    try { await new GithubInstallationBindings(deps.documentClient, deps.tableName, deps.now).claimOperator(companyId, installation); }
    catch (error) { if (!conditional(error)) throw error; into.conflicts++; return; }
  }
  into.written++;
}

/** The workspace's legacy channel bindings, copied into the company's partition with the same fields. */
async function copyChannels(deps: InstallConnectionsDependencies, companyId: string, teamId: string, apply: boolean, into: InstallMoveCounts): Promise<void> {
  const answer = await deps.documentClient.send(new QueryCommand({ TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :channel)",
    ExpressionAttributeValues: { ":pk": channelBindingPartition(SLACK_CHANNEL, teamId), ":channel": SLACK_BINDING_SK_PREFIX }, ConsistentRead: true, Limit: MAX_CHANNELS + 1 })) as { Items?: Row[] };
  if ((answer.Items?.length ?? 0) > MAX_CHANNELS) throw new Error("too many channels");
  // A legacy row that already names a company is not the built-in company's to move.
  for (const row of (answer.Items ?? []).filter((item) => item["companyId"] === undefined || item["companyId"] === IMPLICIT_COMPANY_ID)) {
    into.found++;
    into[await copyChannel(deps, companyId, teamId, row, apply)]++;
  }
}

async function copyChannel(deps: InstallConnectionsDependencies, companyId: string, teamId: string, row: Row, apply: boolean): Promise<"written" | "existing" | "conflicts"> {
  const key = slackChannelBindingKeyFor(companyId, teamId, String(row["sk"]).slice(SLACK_BINDING_SK_PREFIX.length));
  const existing = await get(deps, key);
  if (existing !== undefined) return existing["projectName"] === row["projectName"] ? "existing" : "conflicts";
  if (!apply) return "written";
  const fields = Object.fromEntries(Object.entries(row).filter(([name]) => name !== "pk" && name !== "sk" && name !== "companyId"));
  try { await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: { ...fields, ...key, updatedBy: BY }, ConditionExpression: "attribute_not_exists(pk)" })); }
  catch (error) { if (!conditional(error)) throw error; return "conflicts"; }
  return "written";
}

async function moveWorkspace(deps: InstallConnectionsDependencies, companyId: string, teamId: string, apply: boolean): Promise<WorkspaceOutcome> {
  const bindings = createSlackWorkspaceBindings({ client: deps.documentClient, tableName: deps.tableName, legacyTeamId: teamId, ...(deps.now === undefined ? {} : { now: deps.now }) });
  const stored = await get(deps, teamKey(teamId));
  const owner = stored === undefined ? await bindings.companyOf(teamId) : parseBinding(stored).companyId;
  if (owner === companyId) return "existing";
  if (owner !== undefined && owner !== IMPLICIT_COMPANY_ID) return "conflict";
  if (!apply) return owner === undefined ? "bound" : "moved";
  if (owner === undefined) { await bindings.bind(companyId, teamId, BY); return "bound"; }
  // Before the binding backfill the workspace is the built-in company's only implicitly: the backfill writes that binding, then it moves.
  if (stored === undefined) await bindings.backfill();
  await moveSlackWorkspace({ client: deps.documentClient, tableName: deps.tableName, ...(deps.now === undefined ? {} : { now: deps.now }) }, { teamId, from: IMPLICIT_COMPANY_ID, to: companyId, by: BY, apply: true });
  return "moved";
}

async function get(deps: InstallConnectionsDependencies, key: { pk: string; sk: string }): Promise<Row | undefined> {
  const answer = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Row };
  return answer.Item;
}
