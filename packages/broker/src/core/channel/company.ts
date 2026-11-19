// Which company a chat tenant belongs to, and which people a company serves (owner decision 131). Code runs as one implicit company (45.6), so by default every
// tenant is that company's and every linked person is served. A many-company host answers both: `companyOf` maps a tenant to the one company that owns it
// (undefined: nobody's here), and `isMember` says whether a person is a member the host serves now (an explicit-member rule). Every channel path in the core
// (the sink, commands and the directory, events sent to conversations) asks these, so company A never reads or writes company B's chat.
import type { ActorRef, OrgId } from "@agentx/contracts";

export type ChannelCompanyOf = (where: { channel: string; tenant: string }) => OrgId | undefined | Promise<OrgId | undefined>;
export type ChannelMemberRule = (orgId: OrgId, personId: string, actor: ActorRef) => boolean | Promise<boolean>;

/** Whether `tenant` of `channel` is `orgId`'s. Without a `companyOf` (one company), every tenant is. A failing answer is "not this company's". */
export async function tenantIsCompanys(companyOf: ChannelCompanyOf | undefined, orgId: OrgId, channel: string, tenant: string): Promise<boolean> {
  if (companyOf === undefined) return true;
  try {
    return (await companyOf({ channel, tenant })) === orgId;
  } catch {
    return false;
  }
}

/** Whether the host serves this person now. Without a rule, every linked person is served. A failing rule serves nobody. */
export async function personIsServed(isMember: ChannelMemberRule | undefined, orgId: OrgId, personId: string, actor: ActorRef): Promise<boolean> {
  if (isMember === undefined) return true;
  try {
    return (await isMember(orgId, personId, actor)) === true;
  } catch {
    return false;
  }
}
