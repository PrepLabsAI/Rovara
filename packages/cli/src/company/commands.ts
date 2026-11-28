// #1613: `rovara company show` and `rovara company rename <name>`: the signed-in person's own company (GET and PUT /v1/dev/company/details, company-details-routes.ts).
// A person in no company is told so by the server in its own words; a member who is not an owner or admin is refused with the reason.
import { COMPANY_DETAILS_PATH, CompanyRenameBodySchema, agentXError } from "@agentx/contracts";
import type { Command } from "commander";
import type { DeveloperSessionDeps } from "../developer/session.js";
import { formatSuccess } from "../output.js";
import { appRequest, result, str, type AppResult, type Body } from "../session/app-request.js";

const ROLE_WORDS: Record<string, string> = { owner: "owner", admin: "administrator", member: "member" };

function detailsText(body: Body, renamed: boolean): string {
  const members = typeof body.members === "number" ? body.members : 0;
  const count = `${members.toLocaleString("en-US")}${body.membersAtLeast === true ? "+" : ""} ${members === 1 && body.membersAtLeast !== true ? "member" : "members"}`;
  const name = body.name === null || body.name === undefined ? "(no name)" : str(body.name);
  return [
    ...(renamed ? [`Renamed your company to ${name}.`] : []),
    `Company: ${name}`,
    `  ID: ${str(body.companyId)}`,
    `  Your role: ${ROLE_WORDS[String(body.role)] ?? str(body.role)}`,
    `  Members: ${count}`,
  ].join("\n") + "\n";
}

export async function companyShow(deps: DeveloperSessionDeps, env: string | undefined): Promise<AppResult> {
  const answer = await appRequest(deps, env, COMPANY_DETAILS_PATH);
  return result(answer, answer.body, detailsText(answer.body, false));
}

export async function companyRename(deps: DeveloperSessionDeps, env: string | undefined, name: string): Promise<AppResult> {
  const body = CompanyRenameBodySchema.safeParse({ name });
  if (!body.success) throw agentXError("CONFIG_INVALID", "give the company's new name: 1 to 80 characters, with no control characters");
  const answer = await appRequest(deps, env, COMPANY_DETAILS_PATH, { method: "PUT", body: body.data });
  return result(answer, answer.body, detailsText(answer.body, true));
}

export interface CompanyCommandContext {
  developerSession: () => DeveloperSessionDeps;
  developerEnv: (command: Command) => string | undefined;
  globalOptions: (command: Command) => { json: boolean };
  write: (text: string) => void;
}

export function registerCompanyCommands(program: Command, context: CompanyCommandContext): void {
  const print = (command: Command, answer: AppResult) => context.write(context.globalOptions(command).json ? formatSuccess({ env: answer.env, url: answer.url, ...answer.data }, true) : answer.text);
  const company = program.command("company").description("your company on this Rovara: its name, ID, your role and how many members it has");
  company
    .command("show")
    .description("show your company's name, ID, your role in it and how many members it has")
    .action(async (_options: unknown, command: Command) => print(command, await companyShow(context.developerSession(), context.developerEnv(command))));
  company
    .command("rename")
    .description("give your company a new name (a company owner or administrator only)")
    .argument("<name>", "the new name, 1 to 80 characters")
    .action(async (name: string, _options: unknown, command: Command) => print(command, await companyRename(context.developerSession(), context.developerEnv(command), name)));
}
