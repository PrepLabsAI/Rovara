// #1612: the install's own company, made and filled by init and upgrade with the operator's own AWS credentials, so every install ends with one real company the core accepts and no
// manual steps. Idempotent: run again, it finds the same company and writes nothing new.
//   1. The company: made once (named after the Slack workspace when known, else the environment), or adopted when the install's Slack workspace is already bound to a named company
//      (an install an operator moved by hand, #1300). The init admin's email names its first owner.
//   2. The move: the built-in company's projects, people and grants (install-company-move.ts), then its GitHub installations, Slack workspace and channels
//      (install-company-connections.ts).
// A preview (`apply: false`, doctor) reads only. Lines name counts and outcomes, never people, projects or ids beyond the company's own.
import { SlackTeamIdSchema } from "@agentx/contracts";
import { CompanySignInStore, InstallCompanyStore, moveInstallConnections, moveIntoInstallCompany, slackWorkspaceNamedCompany, type InstallConnectionsReport, type InstallMoveReport } from "@agentx/broker/install-company";

export interface InstallCompanyStepDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  /** The GitHub App's installations; a failure is told and the GitHub part is skipped. */
  installations(): Promise<Array<{ installationId: number; accountLogin: string }>>;
  now: () => number;
  write: (line: string) => void;
}

export interface InstallCompanyStepInput {
  env: string;
  /** The control-plane stack's outputs (StateTableName, DeveloperSignInTableName) and parameters (SlackTeamId). */
  outputs: Record<string, string | undefined>;
  parameters: Record<string, string | undefined>;
  ownerEmail?: string;
  /** The Slack workspace's name, when known: the company's name. */
  slackTeamName?: string;
  apply: boolean;
}

export type InstallCompanyStepResult =
  | { status: "skipped"; reason: string }
  | { status: "done"; companyId: string; outcome: "existing" | "adopted" | "created" | "missing"; move: InstallMoveReport; connections: InstallConnectionsReport };

export async function runInstallCompanyStep(deps: InstallCompanyStepDependencies, input: InstallCompanyStepInput): Promise<InstallCompanyStepResult> {
  const stateTable = input.outputs["StateTableName"], signInTable = input.outputs["DeveloperSignInTableName"];
  if (stateTable === undefined || stateTable === "" || signInTable === undefined || signInTable === "") return { status: "skipped", reason: "the control plane names no sign-in table yet; upgrade it first" };
  const team = SlackTeamIdSchema.safeParse(input.parameters["SlackTeamId"]);
  const teamId = team.success ? team.data : undefined;
  const company = new CompanySignInStore({ documentClient: deps.documentClient, tableName: signInTable, now: deps.now });
  const install = new InstallCompanyStore({ company, documentClient: deps.documentClient, tableName: signInTable, now: deps.now });

  const { companyId, outcome } = await ensureCompany(deps, install, stateTable, teamId, input);
  if (companyId === undefined) return { status: "skipped", reason: "this install has no company yet; run agentx upgrade" };

  const tables = { documentClient: deps.documentClient, tableName: stateTable, signInTableName: signInTable, now: deps.now };
  const move = await moveIntoInstallCompany(tables, { companyId, apply: input.apply });
  let installations: Array<{ installationId: number; accountLogin: string }> = [];
  try { installations = await deps.installations(); } catch { deps.write("Company: the GitHub App's installations could not be read; GitHub is moved on the next run"); }
  const connections = await moveInstallConnections(tables, { companyId, ...(teamId === undefined ? {} : { slackTeamId: teamId }), installations, apply: input.apply });
  return { status: "done", companyId, outcome, move, connections };
}

/** The install's company: found; or (applied) adopted from the Slack workspace's binding, or made; a found one gets the owner's email if it has none yet. A preview makes nothing. */
async function ensureCompany(deps: InstallCompanyStepDependencies, install: InstallCompanyStore, stateTable: string, teamId: string | undefined, input: InstallCompanyStepInput)
  : Promise<{ companyId: string | undefined; outcome: "existing" | "adopted" | "created" | "missing" }> {
  const found = await install.companyId();
  const owner = input.ownerEmail === undefined ? {} : { ownerEmail: input.ownerEmail };
  if (found !== undefined) {
    if (input.apply && input.ownerEmail !== undefined) await install.ensure({ name: companyName(input), ...owner });
    return { companyId: found, outcome: "existing" };
  }
  if (!input.apply) return { companyId: undefined, outcome: "missing" };
  const adopt = teamId === undefined ? undefined : await slackWorkspaceNamedCompany(deps.documentClient, stateTable, teamId);
  return await install.ensure({ name: companyName(input), ...owner, ...(adopt === undefined ? {} : { adoptCompanyId: adopt }) });
}

/** The lines init and upgrade print: what was made or found, and what moved. */
export function installCompanyLines(result: InstallCompanyStepResult): string[] {
  if (result.status === "skipped") return [`Company: skipped, ${result.reason}`];
  const verb = result.move.apply ? "moved" : "to move";
  const { move, connections } = result;
  const lines = [`Company: ${result.companyId} (${result.outcome === "missing" ? "not made yet" : result.outcome})`,
    `Company: ${verb} ${move.projects.written} projects, ${move.people.written} people, ${move.grants.written} grants, ${connections.githubInstallations.written} GitHub installations, ${connections.slackChannels.written} Slack channels; Slack workspace ${connections.slackWorkspace}`];
  const conflicts = move.projects.conflicts + move.people.conflicts + move.grants.conflicts + connections.githubInstallations.conflicts + connections.slackChannels.conflicts + (connections.slackWorkspace === "conflict" ? 1 : 0);
  if (conflicts > 0) lines.push(`Company: ${conflicts} records belong to another company or differ from the built-in company's, and were left as they are`);
  if (move.notSignedIn > 0) lines.push(`Company: ${move.notSignedIn} people with access have not signed in yet; they join when they first sign in`);
  if (move.failed || connections.failed) lines.push("Company: the move did not finish; run agentx upgrade again");
  return lines;
}

/** Whether there is anything left to move, from a preview: what doctor reports. */
export function installCompanyPending(result: InstallCompanyStepResult): number {
  if (result.status === "skipped") return 0;
  const { move, connections } = result;
  return move.projects.written + move.people.written + move.grants.written + connections.githubInstallations.written + connections.slackChannels.written
    + (connections.slackWorkspace === "moved" || connections.slackWorkspace === "bound" ? 1 : 0);
}

function companyName(input: InstallCompanyStepInput): string {
  const name = input.slackTeamName?.trim();
  return name !== undefined && name.length > 0 && name.length <= 80 ? name : input.env;
}
