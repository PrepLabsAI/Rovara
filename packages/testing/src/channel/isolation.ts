// The two-company isolation set for a chat adapter: two companies, each with its own workspace in the tool (its own tenant, its own bot token), sharing the raw ids that are not tenant-bound (the same space, thread and account ids)
// behind one adapter that serves both. What it proves, through the real core channel code (the sink, the cards, the links and the bindings) and the adapter under test:
//
//   events     what Rovara says for company A is shown in A's workspace and never in B's, and an adapter handed a conversation of the other company's workspace refuses it (when the tool has workspaces).
//   secrets    each company's adapter is built from its own company's secret, read for that company only (the ledger fails a read made for the other company while a call is made for this one), and the tool only ever
//              sees the company's own credential.
//   approvals  company A's card is decided only by A: a press that names A's request, made by B's person in B's workspace, decides nothing, and B's own press decides B's own card.
//   closed     when the host cannot say whose a tenant is (its lookup throws or answers nothing), nothing is posted and nothing runs.
//
// The host side is the core's own code: `createChannelSink`, `postApprovalCard`, the bindings and links on a memory store. The router is the fake of what a hosted adapter does (one installation per company); a leaking router is
// built on purpose in the tests to show the set fails on it.
import { MemoryDocumentStore } from "@agentx/broker/ports";
import {
  bindChannelSpace, createChannelSink, issueChannelLinkCode, postApprovalCard, redeemChannelLinkCode, type ChannelCompanyOf, type ChannelWork,
} from "@agentx/broker/channel";
import { agentXError, type ChannelAdapter, type ChannelEvent, type InboundMessage, type OrgId, type SecretRef } from "@agentx/contracts";
import { NO_COMPANY_WORDS } from "../isolation/company-router.js";
import { createCompanySecretStore, type CompanySecretStore } from "../isolation/secret-ledger.js";
import {
  COMPANY_A, COMPANY_B, TWO_COMPANIES, attempt, type FailClosedProbe, type IsolationCompany, type IsolationSurface, type ResolverFailure, type TwoCompanyIsolation,
} from "../isolation/two-company.js";
import { channelEvent, until, type ChannelWorld } from "./channel-conformance.js";
import { fakeChannelWorld } from "./fake-world.js";
import { slackChannelWorld, slackTokens } from "./slack-world.js";

const DIGEST = "c".repeat(64);
const BOT_REF: SecretRef = { env: "CHAT_BOT_TOKEN" };
const APP_REF: SecretRef = { env: "CHAT_APP_TOKEN" };
const NOW = Date.parse("2026-11-10T10:00:00.000Z");
/** A third company the sink is given as its own: with a tenant-to-company lookup, nothing may fall back to it. */
const THIRD_COMPANY = "org_zzzzzzzzzzzzzzzzzzzz" as OrgId;

export type ChannelRouterBuilder = (adapters: ReadonlyMap<string, ChannelAdapter>) => ChannelAdapter;

/** One adapter per tenant behind one `ChannelAdapter`: an event goes to the adapter of the tenant its conversation names. An event for a tenant nobody serves is refused with one fixed sentence. */
export const routeChannelByTenant: ChannelRouterBuilder = (adapters) => {
  const first = [...adapters.values()][0];
  if (first === undefined) throw new Error("a channel router needs at least one tenant");
  return {
    capabilities: first.capabilities, projects: first.projects, stepUp: first.stepUp,
    async deliver(event) {
      const tenant = event.type === "direct" ? event.to.tenant : event.conversation.tenant;
      const adapter = adapters.get(tenant);
      if (adapter === undefined) throw agentXError("FORBIDDEN", NO_COMPANY_WORDS);
      return adapter.deliver(event);
    },
  };
};

export interface ChannelCompanies {
  readonly isolation: TwoCompanyIsolation;
  /** The adapter the core holds: it serves both companies. */
  readonly router: ChannelAdapter;
  readonly worlds: ReadonlyMap<string, ChannelWorld>;
  readonly ledger: CompanySecretStore;
  /** The decisions that reached the approval gate's seam, and the messages that reached the work seam, with the company each ran under. */
  readonly decided: ReadonlyArray<{ orgId: string; requestId: string }>;
  readonly ran: ReadonlyArray<{ orgId: string; text: string }>;
}

export interface ChannelCompaniesOptions {
  /** Which adapter the core delivers through. Default: `routeChannelByTenant`. A test breaks the set on purpose by giving another. */
  router?: ChannelRouterBuilder;
  /** Which company a tenant is. Default: each company's own tenant, nobody's for another. */
  companyOf?: ChannelCompanyOf;
  /** The lookup the fail-closed probes run with when the real one is down. Default: one that throws, or answers nothing. A test gives one that falls back to a company, to show the probes fail on it. */
  lookupWhenDown?: (mode: ResolverFailure) => ChannelCompanyOf;
  /** Slack only: whose secret company X's adapter reads its tokens from. Default: X's own. A test gives the other company's, to show the secret surface fails on it. */
  tokensOf?: (company: IsolationCompany) => IsolationCompany;
}

type WorldMaker = (company: IsolationCompany, ledger: CompanySecretStore) => ChannelWorld;

const tenantOf = (world: ChannelWorld): string => world.conversation.tenant;

function build(make: WorldMaker, options: ChannelCompaniesOptions): ChannelCompanies {
  const ledger = createCompanySecretStore();
  const worlds = new Map(TWO_COMPANIES.map((company) => [company.orgId, make(company, ledger)] as const));
  const world = (company: IsolationCompany): ChannelWorld => worlds.get(company.orgId)!;
  const byTenant = new Map(TWO_COMPANIES.map((company) => [tenantOf(world(company)), world(company).adapter] as const));
  const router = (options.router ?? routeChannelByTenant)(byTenant);
  const companyOf: ChannelCompanyOf = options.companyOf ?? (({ tenant }) => TWO_COMPANIES.find((company) => tenantOf(world(company)) === tenant)?.orgId);

  const store = new MemoryDocumentStore();
  const decided: Array<{ orgId: string; requestId: string }> = [];
  const ran: Array<{ orgId: string; text: string }> = [];
  const sinkLogs: Array<Record<string, unknown>> = [];
  const work: ChannelWork = {
    async message(item) { ran.push({ orgId: item.orgId, text: item.message.text }); },
    async decide(item) { decided.push({ orgId: item.orgId, requestId: item.card.requestId }); return { status: "decided" }; },
  };
  const makeSink = (lookup: ChannelCompanyOf) => createChannelSink({
    channel: world(COMPANY_A).channel, adapter: router, store, orgId: THIRD_COMPANY, companyOf: lookup, now: () => NOW, work, linkWords: (code) => `Link with ${code}.`, log: (entry) => { sinkLogs.push(entry); },
  });
  const deps = (company: IsolationCompany) => ({ store, orgId: company.orgId, now: () => NOW });
  const personOf = (company: IsolationCompany): string => company.label.toLowerCase().repeat(64);

  // A company's space is bound and its person linked once, whichever surface or probe needs it first.
  const ready = new Set<string>();
  const ensureCompany = async (company: IsolationCompany): Promise<void> => {
    if (ready.has(company.orgId)) return;
    ready.add(company.orgId);
    const mine = world(company);
    await bindChannelSpace(deps(company), { channel: mine.channel, tenant: mine.conversation.tenant, space: mine.conversation.space }, mine.adapter.projects[0]!);
    const { code } = await issueChannelLinkCode(deps(company), mine.actor);
    await redeemChannelLinkCode(deps(company), personOf(company), code);
  };

  // ---- events: what is said for one company is shown in its own workspace only.
  const events: IsolationSurface = {
    kind: "event", name: "chat: a message for each company in a space, thread and account that share their ids",
    async plant(me) {
      await ledger.actingFor(me.orgId, () => router.deliver(channelEvent(world(me), "progress", { text: `note ${me.canary}` })));
    },
    async observe(as) {
      const mine = world(as), theirs = world(as === COMPANY_A ? COMPANY_B : COMPANY_A);
      // The other company's conversation, handed to this company's adapter: refused, and never shown in this workspace. (Only a tool that has workspaces can refuse it.)
      const crossed = mine.foreignConversation === undefined ? undefined : await attempt(() => ledger.actingFor(as.orgId, () => mine.adapter.deliver(channelEvent(mine, "progress", { text: `crossed ${(as === COMPANY_A ? COMPANY_B : COMPANY_A).canary}` }, { conversation: theirs.conversation }))));
      return { shown: await mine.shown(), crossed };
    },
  };

  // ---- secrets: each company's adapter reads its own company's secret, and the tool sees only that credential.
  const secrets: IsolationSurface = {
    kind: "secret", name: "chat: each company's token is read for that company and reaches only its own workspace",
    async plant(me) {
      await ledger.actingFor(me.orgId, () => router.deliver(channelEvent(world(me), "progress", { text: `with a token ${me.canary}` })));
      return { handle: undefined, markers: [world(me).secrets[0]!] };
    },
    async observe(as) {
      return { credentials: world(as).seenCredentials!(), reads: ledger.reads.filter((read) => read.companyId === as.orgId).length };
    },
  };

  // ---- approvals: a card is decided by its own company's person, and nobody else's press names it.
  let listening: Array<{ stop(): Promise<void> }> | undefined;
  const requests = new Map<string, { requestId: string; expectedRevision: number; artifactDigest: string }>();
  const sink = makeSink(companyOf);
  const approvals: IsolationSurface = {
    kind: "event", name: "chat: a card and the decision for it, for two companies that share the space and the account",
    async plant(me) {
      if (listening === undefined) {
        listening = await Promise.all(TWO_COMPANIES.map((company) => world(company).adapter.start!(sink)));
        // Both connections are open before anything is read for a company, so a connection never reads its token while another company's call is running.
        await until(() => TWO_COMPANIES.every((company) => world(company).person!.listening()), "both adapters are listening");
      }
      const mine = world(me);
      await ensureCompany(me);
      const card = await ledger.actingFor(me.orgId, () => postApprovalCard({ ...deps(me), companyOf }, {
        channel: mine.channel, adapter: router, conversation: mine.conversation, kind: "other", subject: { type: "workflow-document", id: "task-1" }, revision: 3, artifactDigest: DIGEST,
        text: `Plan ${me.canary} waits.`, taskUrl: "https://example.test/tasks/1", actions: [{ decision: "APPROVE", label: "Approve" }],
      }));
      requests.set(me.label, { requestId: card.requestId, expectedRevision: 3, artifactDigest: DIGEST });
      return { handle: card.requestId, markers: [card.requestId] };
    },
    async observe(as) {
      const person = world(as).person!;
      // The other company's request, named by this company's person in this company's workspace: nothing may be decided by it.
      await person.press("APPROVE", requests.get(as === COMPANY_A ? "B" : "A"));
      const mine = requests.get(as.label)!;
      await person.press("APPROVE", mine);
      await until(() => decided.some((entry) => entry.requestId === mine.requestId), "this company's own press decided its own card");
      return { decided: decided.filter((entry) => entry.orgId === as.orgId), shown: await world(as).shown() };
    },
    async teardown() {
      for (const running of listening ?? []) await running.stop();
      listening = undefined;
    },
  };

  // ---- closed: a tenant lookup that fails posts and runs nothing.
  const lookupFailing = options.lookupWhenDown ?? ((mode: ResolverFailure): ChannelCompanyOf => (mode === "throws" ? () => { throw new Error("the tenant lookup is down"); } : () => undefined));
  const cardProbe: FailClosedProbe = {
    name: "chat: a card for a conversation",
    async prepare() { /* a card carries its own canary in its words */ },
    async attempt(mode) {
      const mine = world(COMPANY_A);
      return postApprovalCard({ ...deps(COMPANY_A), companyOf: lookupFailing(mode) }, {
        channel: mine.channel, adapter: router, conversation: mine.conversation, kind: "other", subject: { type: "workflow-document", id: "task-1" }, revision: 3, artifactDigest: DIGEST,
        text: `Plan ${COMPANY_A.canary} waits.`, taskUrl: "https://example.test/tasks/1", actions: [{ decision: "APPROVE", label: "Approve" }],
      });
    },
  };
  const messageProbe: FailClosedProbe = {
    name: "chat: a message a person sent",
    async prepare() { await ensureCompany(COMPANY_A); },
    async attempt(mode) {
      const mine = world(COMPANY_A);
      const before = ran.length;
      const message: InboundMessage = { version: 2, channel: mine.channel, eventId: `closed-${mode}`, conversation: mine.conversation, actor: mine.actor, text: `add a retry ${COMPANY_A.canary}`, receivedAt: "2026-11-10T10:00:00.000Z" };
      await makeSink(lookupFailing(mode)).message(message);
      // What ran: nothing. (An `undefined` answer is "nothing".)
      return ran.length === before ? undefined : ran.slice(before);
    },
  };

  const surfaces = [events, ...(worlds.get(COMPANY_A.orgId)!.seenCredentials === undefined ? [] : [secrets]), ...(worlds.get(COMPANY_A.orgId)!.person === undefined ? [] : [approvals])];
  return { isolation: { surfaces, failClosed: [cardProbe, messageProbe] }, router, worlds, ledger, decided, ran };
}

/** Two companies on the real Slack adapter: two workspaces (tenants and bot tokens differ) with the same space, thread and account ids. Each adapter reads its token from the company's secret. */
export function slackChannelCompanies(options: ChannelCompaniesOptions = {}): ChannelCompanies {
  return build((company, ledger) => {
    const tag = `company${company.label.toLowerCase()}`;
    const tokens = slackTokens(tag);
    ledger.set(company.orgId, BOT_REF, tokens.bot);
    ledger.set(company.orgId, APP_REF, tokens.app);
    const readFor = (options.tokensOf ?? ((own: IsolationCompany) => own))(company);
    const read = (ref: SecretRef) => async (): Promise<string> => {
      const value = await ledger.read(readFor.orgId, ref);
      if (value === undefined) throw new Error("no secret");
      return value.reveal();
    };
    return slackChannelWorld({ tenant: company.label === "A" ? "T0AAAAAAA" : "T0BBBBBBB", tokenTag: tag, botToken: read(BOT_REF), appToken: read(APP_REF) });
  }, options);
}

/** Two companies on the in-process fake: two tenants with the same space and account ids. The fake has no workspace of its own to refuse a foreign conversation, and no credential, so those surfaces are left out. */
export function fakeChannelCompanies(options: ChannelCompaniesOptions = {}): ChannelCompanies {
  return build((company) => fakeChannelWorld({ tenant: company.label === "A" ? "teamA" : "teamB" }), options);
}

/** A leaking router for tests: every event goes to the first company's adapter, whoever it is for. */
export const routeEverythingToTheFirst: ChannelRouterBuilder = (adapters) => {
  const first = [...adapters.values()][0]!;
  return { capabilities: first.capabilities, projects: first.projects, stepUp: first.stepUp, deliver: (event: ChannelEvent) => first.deliver(event) };
};
