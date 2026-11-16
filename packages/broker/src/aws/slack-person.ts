// DEC 211: one Slack account is a person only through a company-checked link or sign-in membership.
import { AsyncLocalStorage } from "node:async_hooks";
import { type SlackWorkspaceDelivery } from "./slack-workspace-tokens.js";
import { recordInCompany } from "./company-check.js";
import { LINK_REQUIRED_INTERVAL_SECONDS, orgScoped, when, ChannelLinkSchema, OrgIdSchema, SlackUserIdSchema, agentXError, type DocumentStore } from "@agentx/contracts";
import { linkedPerson, issueChannelLinkCode, previewChannelLinkCode, redeemChannelLinkCode } from "../core/channel/links.js";
import { developerIdForSlackUser } from "./admin-actions.js";
import type { CompanyMembershipReader } from "./company-check.js";
import { SlackWorkspaceRefused, slackWorkspaceTeam, type SlackWorkspaceBindings } from "./slack-workspace-binding.js";

export type SlackPerson = { kind: "linked"; companyId: string; personId: string; via: "signin" | "link" } | { kind: "unlinked"; companyId: string };
export interface SlackPersonDependencies {
  workspaces: Pick<SlackWorkspaceBindings, "requireCompany">;
  companies?: CompanyMembershipReader | undefined;
  store: DocumentStore;
  now?: () => number;
}

export function createSlackPersonResolver(deps: SlackPersonDependencies): (input: { teamId: string; userId: string }) => Promise<SlackPerson> {
  const now = deps.now ?? Date.now;
  return async function resolveSlackPerson(input): Promise<SlackPerson> {
    const started = now();
    if (input === null || typeof input !== "object" || !slackWorkspaceTeam(input.teamId) || !SlackUserIdSchema.safeParse(input.userId).success) throw new SlackWorkspaceRefused();
    let company: string;
    try { company = await deps.workspaces.requireCompany(input.teamId); } catch { throw new SlackWorkspaceRefused(); }
    if (!OrgIdSchema.safeParse(company).success || now() - started > 10_000) throw new SlackWorkspaceRefused();
    const unlinked: SlackPerson = { kind: "unlinked", companyId: company };
    if (deps.companies === undefined) return unlinked;
    try {
      const actor = { channel: "slack", tenant: input.teamId, userId: input.userId };
      // The core reader sees the exact validated row, once. Invalid existing links must not
      // disappear into a sign-in fallback. Fixed-size keys; one link read and at most two member reads.
      const link = await linkedPerson({ orgId: company, now, store: { ...deps.store, get: async (key) => {
        const row = await deps.store.get(key);
        if (row === undefined) return undefined;
        if (Buffer.byteLength(JSON.stringify(row)) > 65_536 || row.entityType !== "CHANNEL_LINK" || row.pk !== key.pk || row.sk !== key.sk) throw new SlackWorkspaceRefused();
        // Link rows are durable; only their key and entity tag are storage metadata.
        const parsed = ChannelLinkSchema.safeParse(Object.fromEntries(Object.entries(row).filter(([field]) => !["pk", "sk", "entityType"].includes(field))));
        if (!parsed.success || parsed.data.actor.channel !== "slack" || parsed.data.actor.tenant !== input.teamId || parsed.data.actor.userId !== input.userId) throw new SlackWorkspaceRefused();
        return row;
      } } }, actor);
      if (now() - started > 10_000) return unlinked;
      const native = developerIdForSlackUser(input.userId);
      const nativeCompany = await deps.companies.companyOf(native);
      if (now() - started > 10_000) return unlinked;
      // An absent native membership is normal for someone linked from web sign-in. A
      // present foreign/malformed membership is never silently replaced by a link.
      if (nativeCompany !== undefined && (!OrgIdSchema.safeParse(nativeCompany).success || nativeCompany !== company)) return unlinked;
      if (link !== undefined) {
        if (nativeCompany !== undefined && link !== native) return unlinked;
        const member = link === native ? nativeCompany : await deps.companies.companyOf(link);
        if (!OrgIdSchema.safeParse(member).success || member !== company || now() - started > 10_000) return unlinked;
        return { kind: "linked", companyId: company, personId: link, via: "link" };
      }
      return nativeCompany === company ? { kind: "linked", companyId: company, personId: native, via: "signin" } : unlinked;
    } catch { return unlinked; }
  };
}

/** Core code paths are fixed: one put for issue, one get for preview, or two gets
 * and one three-item transaction for redemption. They share one response-byte and
 * elapsed-time budget. Await each I/O; the host owns its timeout, with no detached writer. */
function slackLinkStore(deps: SlackPersonDependencies, started: number): DocumentStore {
  const now = deps.now ?? Date.now;
  let bytes = 0;
  const check = () => { if (bytes > 65_536 || now() - started > 10_000) throw new SlackWorkspaceRefused(); };
  const checked = async <T>(io: () => Promise<T>): Promise<T> => {
    check();
    const answer = await io();
    bytes += Buffer.byteLength(JSON.stringify(answer) ?? "");
    check();
    return answer;
  };
  return { ...deps.store,
    get: (key) => checked(() => deps.store.get(key)),
    put: (request) => checked(() => deps.store.put(request)),
    transact: (items) => checked(() => deps.store.transact(items)),
  };
}

/** Company-scoped core codes for the web confirmation wiring. The authenticated person,
 * never a URL/company parameter, chooses the partition; the code's workspace must agree. */
export function createSlackLinkCodes(deps: SlackPersonDependencies) {
  const now = deps.now ?? Date.now;
  const expired = () => agentXError("NOT_FOUND", "This link has expired or was already used.");
  const preview = async (personId: string, code: string) => {
    const started = now();
    try {
      if (typeof personId !== "string" || personId.length < 1 || personId.length > 200 || deps.companies === undefined) return undefined;
      const company = await deps.companies.companyOf(personId);
      if (!OrgIdSchema.safeParse(company).success || company === undefined || now() - started > 10_000) return undefined;
      const linkDeps = { store: slackLinkStore(deps, started), orgId: company, now };
      const found = await previewChannelLinkCode(linkDeps, code);
      if (found === undefined || found.channel !== "slack" || !slackWorkspaceTeam(found.tenant) || !SlackUserIdSchema.safeParse(found.userId).success || now() - started > 10_000) return undefined;
      if (await deps.workspaces.requireCompany(found.tenant) !== company || now() - started > 10_000) return undefined;
      return { found, linkDeps };
    } catch { return undefined; }
  };
  return {
    async issue(input: { teamId: string; userId: string }) {
      const started = now();
      try {
        if (input === null || typeof input !== "object" || !slackWorkspaceTeam(input.teamId) || !SlackUserIdSchema.safeParse(input.userId).success) throw new SlackWorkspaceRefused();
        const company = await deps.workspaces.requireCompany(input.teamId);
        if (!OrgIdSchema.safeParse(company).success || now() - started > 10_000) throw new SlackWorkspaceRefused();
        return await issueChannelLinkCode({ store: slackLinkStore(deps, started), orgId: company, now }, { channel: "slack", tenant: input.teamId, userId: input.userId });
      } catch { throw new SlackWorkspaceRefused(); }
    },
    async preview(personId: string, code: string) { return (await preview(personId, code))?.found; },
    async redeem(personId: string, code: string) {
      const found = await preview(personId, code);
      if (found === undefined) throw expired();
      try { return await redeemChannelLinkCode(found.linkDeps, personId, code); }
      catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "CHANGE_STALE") throw agentXError("CHANGE_STALE", "That account is already linked.");
        throw expired();
      }
    },
  };
}

/** Hosted Slack uses the same binding, token and link store as the core. Membership is
 * deliberately a separate optional dependency: an absent reader means unlinked. */
export interface SlackWorkspaceAccess extends SlackWorkspaceDelivery {
  store: DocumentStore;
  getProject(name: string): Promise<unknown>;
  linkUrl(code: string): string;
}
export interface SlackCompanyDependencies {
  workspaces?: SlackWorkspaceAccess;
  companies?: CompanyMembershipReader;
  now?: () => number;
}

export const SLACK_LINK_NOTICE = "link your account: Open in Rovara";
export const slackRequestWorkspace = new AsyncLocalStorage<{ teamId: string; companyId: string; token: string }>();

/** No caller identity is cached: queued work re-resolves links and membership on execution. */
export async function slackCompanyPerson(deps: SlackCompanyDependencies, teamId: string, userId: string): Promise<SlackPerson> {
  if (deps.workspaces === undefined) throw new SlackWorkspaceRefused();
  return createSlackPersonResolver({ workspaces: deps.workspaces, store: deps.workspaces.store, companies: deps.companies, ...(deps.now === undefined ? {} : { now: deps.now }) })({ teamId, userId });
}

export async function slackCompanyProject(deps: SlackCompanyDependencies, teamId: string, name: string): Promise<boolean> {
  if (deps.workspaces === undefined) return true;
  try {
    const company = await deps.workspaces.requireCompany(teamId);
    return OrgIdSchema.safeParse(company).success && recordInCompany(await deps.workspaces.getProject(name), company);
  } catch { return false; }
}

/** Only the verified request establishes this context. Read it once per Web API call. */
export async function slackCompanyToken(deps: SlackCompanyDependencies, legacy: () => Promise<string>): Promise<string> {
  if (deps.workspaces === undefined) return legacy();
  const context = slackRequestWorkspace.getStore();
  if (context === undefined) throw new SlackWorkspaceRefused();
  return context.token;
}

/** A bounded, company-scoped notice claim. No EVENT, queue, counter or task is written. */
export async function slackLinkNotice(deps: SlackCompanyDependencies, teamId: string, userId: string): Promise<string | undefined> {
  if (deps.workspaces === undefined || !slackWorkspaceTeam(teamId) || !SlackUserIdSchema.safeParse(userId).success) throw new SlackWorkspaceRefused();
  const now = deps.now ?? Date.now;
  const started = now();
  const company = await deps.workspaces.requireCompany(teamId);
  const key = { pk: orgScoped(company, `CHANNEL_CLAIM#slack/LINK_NOTICE#${teamId}/${userId}`), sk: "CLAIM" };
  const seconds = Math.floor(now() / 1000);
  const store = slackLinkStore({ workspaces: deps.workspaces, store: deps.workspaces.store, now }, started);
  const claim = await store.put({ item: { ...key, expiresAt: seconds + LINK_REQUIRED_INTERVAL_SECONDS }, condition: when.or(when.absent(), when.lte("expiresAt", seconds)) });
  if (!claim.applied) return undefined;
  const codes = createSlackLinkCodes({ workspaces: deps.workspaces, store, now });
  const { code } = await codes.issue({ teamId, userId });
  return `${SLACK_LINK_NOTICE}: ${deps.workspaces.linkUrl(code)}`;
}
