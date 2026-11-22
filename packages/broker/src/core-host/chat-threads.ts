// L4-U5b: what a hosted install gives the core so a task started from a chat thread is told there (the milestone lines of `core/channel/thread-notices.ts`: a pause at Build for a broken setup, the pull request, the end).
// Neutral: no chat tool's name is here. The deployment builds one from its chat tool's own company-scoped seam (a team that belongs to a company, that company's bot token); the core only asks two things of it:
//   companyOf     which company a chat tenant belongs to (undefined: nobody's here). A thread in another company's tenant is never recorded and never sent to.
//   registryFor   the chat adapters of ONE company, as the thread notices read them (`registry.get("channel", name)`). An adapter made for company A can only reach company A's tenants.
import type { ActorRef, ChannelAdapter, OrgId, RichMessage } from "@agentx/contracts";
import type { ChannelCompanyOf } from "../core/channel/company.js";

export interface ChatThreads {
  companyOf: ChannelCompanyOf;
  adapterFor(companyId: OrgId, channel: string): ChannelAdapter | undefined;
  /**
   * HW5b: the Rovara person a chat account is in this company, read now (a link the person made, or the chat's own sign-in membership), or undefined for nobody. `via: "link"` names a link row, so a decision made in the chat is
   * fenced on it (`channelLinkFence`). Absent: the chat takes no decision (a card is the sign-in card).
   */
  personOf?(companyId: OrgId, actor: ActorRef): Promise<{ personId: string; via: "link" | "signin" } | undefined>;
  /** HW5: the names of the chats this seam serves (what `registry.names("channel")` says), so the notice service sees them as the company's chats. */
  channels: readonly string[];
  /** The chat service translates its existing message builder output at the adapter boundary. */
  messageOf?(message: { text: string; blocks: unknown[] }): RichMessage | undefined;
  /** The chat service classifies its own transport failures; an unanswered create must never be repeated. */
  documentFailure?(error: unknown): { mayHaveLanded: boolean; unavailable: boolean; category?: string };
  /** Internal hosted seam: persist an exact Canvas ID before Slack shares it, as the retired notifier did. */
  createPlanCanvas?(companyId: OrgId, tenant: string, input: { channel: string; taskId: string; title: string; version: number; markdown: string }, onCreated: (canvasId: string) => Promise<void>): Promise<{ canvasId: string; permalink: string }>;

}
