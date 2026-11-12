// Spec 062 FR-072 (commands) and phase 7c1b (the directory) for an in-process adapter (`ChannelAdapter.command`), kept inside one company (owner decision 131).
// A command names the tenant it acts in, and the core sends it only when that tenant is the asking company's (`companyOf`); a kind that names no tenant (a form
// handle, a document id, the health check) is sent only by an install of one company, where there is nobody else to reach. What comes back is read the same
// way: a directory person whose own tenant is another company's (or nobody's) is answered as unknown, so one company's search never shows another's people.
import {
  COMMAND_CAPABILITY, ChannelCommandAnswerSchema, ChannelCommandFailed, ChannelCommandResultSchemas, ChannelCommandSchema, agentXError, channelCommandId,
  type ChannelAdapter, type ChannelCommand, type ChannelCommandInput, type ChannelCommandKind, type ChannelCommandResult, type DirectoryUser, type OrgId,
} from "@agentx/contracts";
import { tenantIsCompanys, type ChannelCompanyOf } from "./company.js";

export interface ChannelCommandDeps {
  /** The adapter's name in the registry. */
  channel: string;
  adapter: Pick<ChannelAdapter, "capabilities" | "command">;
  /** The asking company. */
  orgId: OrgId;
  /** As the sink's: which company a tenant belongs to. Absent: one company, whose every tenant is. */
  companyOf?: ChannelCompanyOf | undefined;
  now: () => number;
}

/** Whether this adapter takes a kind in process: it has `command` and declares the kind's capability. */
export function adapterTakesInProcessCommand(adapter: Pick<ChannelAdapter, "capabilities" | "command">, kind: ChannelCommandKind): boolean {
  return adapter.command !== undefined && adapter.capabilities[COMMAND_CAPABILITY[kind]] === true;
}

/** The tenant a command acts in, or undefined when it names none. */
function tenantOf(command: ChannelCommand): string | undefined {
  if (command.kind === "direct_message") return command.to.tenant;
  return "tenant" in command ? command.tenant : undefined;
}

const OTHER_COMPANY = "that is not a space of this company's chat";

/**
 * Sends one command and answers its checked result. FORBIDDEN when the command's tenant is not the company's (or it names none in a many-company install);
 * ChannelCommandFailed as the webhook client's: `refused` when the adapter said no, `unanswered` when no readable answer came.
 */
export async function sendChannelCommand<K extends ChannelCommandKind>(deps: ChannelCommandDeps, kind: K, input: ChannelCommandInput<K>): Promise<ChannelCommandResult<K>> {
  if (!adapterTakesInProcessCommand(deps.adapter, kind)) throw agentXError("CONFIG_INVALID", `the ${deps.channel} adapter does not take the ${kind} command`);
  const command = ChannelCommandSchema.parse({ ...input, version: 1, id: channelCommandId(), channel: deps.channel, createdAt: new Date(deps.now()).toISOString(), kind });
  const tenant = tenantOf(command);
  if (tenant === undefined ? deps.companyOf !== undefined : !(await tenantIsCompanys(deps.companyOf, deps.orgId, deps.channel, tenant))) throw agentXError("FORBIDDEN", OTHER_COMPANY);
  let raw: unknown;
  try {
    raw = await deps.adapter.command!(command);
  } catch {
    throw new ChannelCommandFailed("unanswered", `the ${deps.channel} adapter did not answer the ${kind} command`);
  }
  const answer = ChannelCommandAnswerSchema.safeParse(raw);
  if (!answer.success) throw new ChannelCommandFailed("unanswered", `the ${deps.channel} adapter's answer is unreadable`);
  if (!answer.data.ok) throw new ChannelCommandFailed("refused", `the ${deps.channel} adapter refused the ${kind} command: ${answer.data.error.code}`, answer.data.error.code);
  const result = ChannelCommandResultSchemas[kind].safeParse(answer.data.result);
  if (!result.success) throw new ChannelCommandFailed("unanswered", `the ${deps.channel} adapter's ${kind} result is unreadable`);
  const data = result.data as ChannelCommandResult<K>;
  if ((kind === "user" || kind === "user_by_email") && tenant !== undefined) {
    const user = (data as { user?: DirectoryUser }).user;
    if (user !== undefined && !(await personIsCompanys(deps, user, tenant))) return { user: undefined } as unknown as ChannelCommandResult<K>;
  }
  return data;
}

/** A directory person is the company's when their own tenant is (or, naming none, the tenant asked about is). */
async function personIsCompanys(deps: ChannelCommandDeps, user: DirectoryUser, asked: string): Promise<boolean> {
  return tenantIsCompanys(deps.companyOf, deps.orgId, deps.channel, user.tenant ?? asked);
}

/** Phase 7c1b: a person in the company's chat by their account id, or undefined (unknown, or another company's). */
export async function directoryUser(deps: ChannelCommandDeps, tenant: string, userId: string): Promise<DirectoryUser | undefined> {
  return (await sendChannelCommand(deps, "user", { tenant, userId })).user;
}

/** Phase 7c1b: a person in the company's chat by email, or undefined (unknown, or another company's). */
export async function directoryUserByEmail(deps: ChannelCommandDeps, tenant: string, email: string): Promise<DirectoryUser | undefined> {
  return (await sendChannelCommand(deps, "user_by_email", { tenant, email })).user;
}
