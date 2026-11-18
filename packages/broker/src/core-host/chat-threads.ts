// L4-U5b: what a hosted install gives the core so a task started from a chat thread is told there (the milestone lines of `core/channel/thread-notices.ts`: a pause at Build for a broken setup, the pull request, the end).
// Neutral: no chat tool's name is here. The deployment builds one from its chat tool's own company-scoped seam (a team that belongs to a company, that company's bot token); the core only asks two things of it:
//   companyOf     which company a chat tenant belongs to (undefined: nobody's here). A thread in another company's tenant is never recorded and never sent to.
//   registryFor   the chat adapters of ONE company, as the thread notices read them (`registry.get("channel", name)`). An adapter made for company A can only reach company A's tenants.
import type { ChannelAdapter, OrgId } from "@agentx/contracts";
import type { ChannelCompanyOf } from "../core/channel/company.js";

export interface ChatThreads {
  companyOf: ChannelCompanyOf;
  adapterFor(companyId: OrgId, channel: string): ChannelAdapter | undefined;
}
