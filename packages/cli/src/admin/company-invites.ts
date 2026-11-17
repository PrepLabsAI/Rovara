// DEC 254a: an install administrator's company invite codes. The code is made here and shown once; only its hash leaves this process.
import { agentXError, CompanyInviteListSchema, type CompanyInviteList, type CompanyInviteView } from "@agentx/contracts";
import { adminResponseBody } from "./http.js";

export async function listCompanyInvites(session: { controlPlaneUrl: string; accessToken: string }, fetchImplementation: typeof fetch = fetch): Promise<CompanyInviteList> {
  let response: Response;
  try {
    response = await fetchImplementation(`${session.controlPlaneUrl.replace(/\/$/, "")}/v1/admin/company-invites`, { headers: { authorization: `Bearer ${session.accessToken}` } });
  } catch {
    throw agentXError("RUNTIME_UNAVAILABLE", "could not reach AgentX to list company invite codes; try again");
  }
  const body = await adminResponseBody(response);
  const { requestId: _requestId, ...rest } = (body ?? {}) as Record<string, unknown>;
  void _requestId;
  const list = CompanyInviteListSchema.safeParse(rest);
  if (!list.success) throw agentXError("RUNTIME_UNAVAILABLE", "AgentX answered with invite codes this version of the CLI cannot read; upgrade the CLI");
  return list.data;
}

export const describeCompanyInvite = (invite: CompanyInviteView) =>
  `${invite.codeId}  ${invite.status}  expires ${invite.expiresAt}  created ${invite.createdAt}${invite.usedAt === undefined ? "" : `  used ${invite.usedAt}`}${invite.revokedAt === undefined ? "" : `  revoked ${invite.revokedAt}`}`;

/** The hours flag, refused in fixed words. */
export function inviteExpiryHours(value: string): number {
  const hours = Number(value);
  if (!/^[0-9]{1,3}$/.test(value) || !Number.isInteger(hours) || hours < 1 || hours > 720) throw agentXError("CONFIG_INVALID", "--expires-in-hours: give a whole number of hours from 1 to 720");
  return hours;
}
