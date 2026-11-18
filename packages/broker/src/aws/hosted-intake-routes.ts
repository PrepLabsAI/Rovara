// Lead 2 L2-4 (DEC 254o c, DEC 254n): a project's waiting tickets on hosted Code, for the people who run the project.
//
//   GET  /v1/dev/projects/{project}/intake                      the waiting tickets: { items: IntakeWaitingItem[], sources: [] } (the laptop's IntakeWaitingListSchema)
//   POST /v1/dev/projects/{project}/intake/{itemId}/start       { requestId }  "Start": the work is the presser's ({ started: true, taskId, sessionId? } or { started: false, reason | state })
//   POST /v1/dev/projects/{project}/intake/{itemId}/dismiss     { requestId }  "Not this one": { dismissed: true }
//
// Who (DEC 254n, the same rule as a project's Linear team, linear-connect-routes.ts): a live company owner or admin, or the project's own administrator (a grant read within the company).
//   - The company and role are the caller's LIVE membership, read at every call; never a body, query, header or token claim.
//   - A project that is not this company's (another company's, a missing one, a bad name), and a person with no grant on it, all get the same 404 "project not found".
//   - A project member who is not its admin gets the fixed 403. "Start" also needs the presser's own right to start work on the project (the engine's `mayStart`, then the start's
//     own check): a company admin with no grant on the project may see and dismiss, and gets the fixed 403 on Start.
//   - A ticket id that is not this project's waiting ticket (another project's, another company's, started, unknown) is one 404. Fixed words throughout, never the request's own.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXNameSchema, IntakeDismissBodySchema, IntakeStartBodySchema, agentXError, CLI_COMMAND_NAME } from "@agentx/contracts";
import { Membership, membershipKey } from "./company-check.js";
import type { DeveloperCaller } from "./developer-routes.js";
import type { AdaptedHttpRequest } from "./lambda.js";
import type { HostedIntake } from "./hosted-intake.js";

export const INTAKE_PROJECT_NOT_FOUND = "project not found";
export const INTAKE_ADMIN_ONLY = "Only a company owner or admin, or the project's admin, can see and act on its waiting tickets.";
export const INTAKE_NO_TICKET = "no such waiting ticket";
export const INTAKE_CANNOT_START = "You can't start work on this project.";
export const INTAKE_UNAVAILABLE = "The waiting tickets could not be read just now; try again.";
const SIGN_IN_AGAIN = `your Rovara sign-in has ended; run ${CLI_COMMAND_NAME} login <url> again`;

export interface HostedIntakeRouteContext {
  documentClient: { send(command: unknown): Promise<unknown> };
  signInTableName: string;
  intake: HostedIntake;
  /** Whether the project exists AND is this company's (its latest revision's company). */
  projectInCompany: (project: string, companyId: string) => Promise<boolean>;
  /** The person's grant on the project, read only within the company. */
  projectRole: (project: string, personId: string, companyId: string) => Promise<"administrator" | "developer" | undefined>;
}

/** What the dispatcher matched: the raw project segment, and for an act the raw ticket id and the act. */
export interface HostedIntakeMatch { project: string; itemId?: string | undefined; act?: string | undefined }

function body(request: AdaptedHttpRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { return undefined; }
}

/**
 * The routes. The caller is authenticated and its route row (`full`) applied; `companyId` is its live membership's company (resolveCompany). The membership row is read again here, so
 * a role or company that changed since is what counts.
 */
export async function routeHostedIntake(ctx: HostedIntakeRouteContext, caller: DeveloperCaller, companyId: string, request: AdaptedHttpRequest, match: HostedIntakeMatch): Promise<unknown> {
  let member: ReturnType<typeof Membership.parse>;
  try {
    const response = await ctx.documentClient.send(new GetCommand({ TableName: ctx.signInTableName, Key: membershipKey(caller.developerId), ConsistentRead: true })) as { Item?: unknown };
    member = Membership.parse(response.Item);
    if (member.personId !== caller.developerId || member.companyId !== companyId || member.revokedAt !== undefined) throw new Error("membership");
  } catch { throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN); }
  const company = member.companyId;
  const admin = member.role === "owner" || member.role === "admin";

  let project: string;
  try { project = decodeURIComponent(match.project); } catch { throw agentXError("NOT_FOUND", INTAKE_PROJECT_NOT_FOUND); }
  if (!AgentXNameSchema.safeParse(project).success) throw agentXError("NOT_FOUND", INTAKE_PROJECT_NOT_FOUND);
  let inCompany: boolean; let role: "administrator" | "developer" | undefined;
  try { [inCompany, role] = await Promise.all([ctx.projectInCompany(project, company), admin ? Promise.resolve(undefined) : ctx.projectRole(project, caller.developerId, company)]); }
  catch { throw agentXError("RUNTIME_UNAVAILABLE", INTAKE_UNAVAILABLE); }
  if (!inCompany) throw agentXError("NOT_FOUND", INTAKE_PROJECT_NOT_FOUND);
  if (!admin) {
    if (role === undefined) throw agentXError("NOT_FOUND", INTAKE_PROJECT_NOT_FOUND);
    if (role !== "administrator") throw agentXError("FORBIDDEN", INTAKE_ADMIN_ONLY);
  }

  if (match.itemId === undefined) {
    if (request.method !== "GET") throw agentXError("NOT_FOUND", "not found");
    try { return await ctx.intake.waiting(company, project); } catch { throw agentXError("RUNTIME_UNAVAILABLE", INTAKE_UNAVAILABLE); }
  }
  if (request.method !== "POST" || (match.act !== "start" && match.act !== "dismiss")) throw agentXError("NOT_FOUND", "not found");
  const schema = match.act === "start" ? IntakeStartBodySchema : IntakeDismissBodySchema;
  if (!schema.safeParse(body(request)).success) throw agentXError("CONFIG_INVALID", "this takes { requestId }");
  const itemId = match.itemId;
  if (match.act === "dismiss") {
    let dismissed: boolean;
    try { dismissed = await ctx.intake.dismiss(company, project, itemId, caller.developerId); } catch { throw agentXError("RUNTIME_UNAVAILABLE", INTAKE_UNAVAILABLE); }
    if (!dismissed) throw agentXError("NOT_FOUND", INTAKE_NO_TICKET);
    return { dismissed: true };
  }
  let outcome: Awaited<ReturnType<HostedIntake["start"]>>;
  // A fault that may pass (the start service away) is a 503; the ticket was given back and waits, so pressing again works.
  try { outcome = await ctx.intake.start(company, project, itemId, caller.developerId); } catch { throw agentXError("RUNTIME_UNAVAILABLE", INTAKE_UNAVAILABLE); }
  if (outcome.outcome === "not_found") throw agentXError("NOT_FOUND", INTAKE_NO_TICKET);
  if (outcome.outcome === "forbidden") throw agentXError("FORBIDDEN", INTAKE_CANNOT_START);
  if (outcome.outcome === "started") return { started: true, taskId: outcome.taskId, ...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }) };
  if (outcome.outcome === "waiting") return { started: false, reason: outcome.reason };
  return { started: false, state: outcome.state };
}
