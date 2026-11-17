// DEC 254o (b), L2-2 PR 18b: Slack company mode for every team but the install's own. The broker's company path (its `workspaces` dependency) is all-or-nothing, so the
// split is made per request, before any of it runs: a request for SLACK_TEAM_ID's team (or one naming no team) goes to a handler built WITHOUT `workspaces`, which is today's
// broker exactly; a request naming another team goes to the company handler. With no `workspaces` at all (the switch off) there is only today's handler.
// Choosing by a field the request carries is safe: each handler still checks the request in full (IAM for direct invokes, signatures and sign-in for HTTP), and the company
// handler's own binding checks decide what another team may do. Naming the install's team only ever selects today's checks.
import { parseSlackThreadSubject } from "@agentx/contracts";
import { previewLinkCode, redeemLinkCode, type ChannelLinkDependencies } from "./channel-links.js";

/** A header by name, as the broker reads headers (names compared without case). */
function header(headers: unknown, name: string): unknown[] {
  if (headers === null || typeof headers !== "object") return [];
  return Object.entries(headers as Record<string, unknown>).filter(([key]) => key.toLowerCase() === name).map(([, value]) => value);
}

/** The path as the broker routes on it (`new URL(path, base).pathname`: backslashes, tabs and fragments normalised), or undefined when it does not parse. */
function brokerPath(rawPath: unknown): string | undefined {
  if (typeof rawPath !== "string") return undefined;
  try { return new URL(rawPath, "https://agentx.invalid").pathname; } catch { return undefined; }
}

/**
 * What team a broker event names: `{ named: false }` when it carries no team field at all; otherwise `{ named: true, team }` with the team as given (undefined when the value is
 * unreadable). Read from a direct invoke's `thread.teamId` or `teamId`, an HTTP call's Slack thread header (any case), or an administrator's binding path
 * /v1/admin/slack/bindings/<team>/<channel> (decoded once, as the broker decodes it).
 */
export function slackRequestTeam(event: unknown): { named: false } | { named: true; team: string | undefined } {
  if (event === null || typeof event !== "object" || Array.isArray(event)) return { named: false };
  const value = event as { requestContext?: unknown; headers?: unknown; rawPath?: unknown; thread?: unknown; teamId?: unknown };
  const teams: Array<string | undefined> = [];
  // HTTP-shaped (API Gateway, or a direct invoke carrying a path or headers): the Slack thread header(s) and the admin binding path, read as the broker reads them.
  if (value.requestContext !== undefined || value.rawPath !== undefined || value.headers !== undefined) {
    for (const subject of header(value.headers, "x-agentx-slack-thread")) {
      try { teams.push(typeof subject === "string" ? parseSlackThreadSubject(subject).teamId : undefined); } catch { teams.push(undefined); }
    }
    if (value.rawPath !== undefined) {
      const path = brokerPath(value.rawPath);
      if (path === undefined) teams.push(undefined);
      else {
        // Compared segment by segment: this reads the broker's existing PUT|DELETE binding route (broker.ts), it serves none of its own.
        const parts = path.split("/");
        if (parts.length === 7 && parts[0] === "" && parts.slice(1, 5).join(" ") === ADMIN_BINDING) {
          try { teams.push(decodeURIComponent(parts[5]!)); } catch { teams.push(undefined); }
        }
      }
    }
  }
  if (value.thread !== undefined) {
    const thread = value.thread;
    teams.push(thread !== null && typeof thread === "object" && typeof (thread as { teamId?: unknown }).teamId === "string" ? (thread as { teamId: string }).teamId : undefined);
  }
  if ("teamId" in value) teams.push(typeof value.teamId === "string" ? value.teamId : undefined);
  if (teams.length === 0) return { named: false };
  // Every field must agree; two different (or unreadable) values are "named, unknown", which never reaches the install's handler.
  return { named: true, team: teams.every((team) => team !== undefined && team === teams[0]) ? teams[0] : undefined };
}

/** The person-facing link page (/review/link/<code>): a company code is found only through the company handler, which still serves the install's codes as before. */
const LINK_PAGE = "/review/link/";
/** An administrator's channel binding change: the path's segments v1 admin slack bindings <team> <channel>. */
const ADMIN_BINDING = "v1 admin slack bindings";

/**
 * Whether the company handler serves this event. Fail closed: only an event that names no team at all, or names exactly the install's team, reaches today's handler. Any other
 * named team, including one no check recognises (an Enterprise Grid id, an encoded or unreadable value), gets the company handler and its binding checks. The link page too.
 */
export function slackCompanyServes(event: unknown, legacyTeamId: string | undefined): boolean {
  const named = slackRequestTeam(event);
  if (named.named) return legacyTeamId === undefined || named.team !== legacyTeamId;
  const value = event as { requestContext?: unknown; rawPath?: unknown } | null;
  return value !== null && typeof value === "object" && value.requestContext !== undefined && (brokerPath(value.rawPath)?.startsWith(LINK_PAGE) ?? false);
}

/** The legacy view of the broker's dependencies: everything as given, without the company path. */
export function withoutSlackCompanyMode<T extends { workspaces?: unknown; slackInstallTeamOnly?: string }>(dependencies: T, installTeamId?: string): T {
  const { workspaces: _company, ...legacy } = dependencies;
  void _company;
  // Defence in depth: in this view another team's channel binding is "not bound" (slackCompanyProject), whatever route names it.
  return (installTeamId === undefined ? legacy : { ...legacy, slackInstallTeamOnly: installTeamId }) as T;
}

/** Two handlers, one per mode, built once; `company` undefined means the switch is off and `legacy` is today's handler, returned as it is. */
export function splitBySlackTeam<E, C, R>(legacy: (event: E, context?: C) => R, company: ((event: E, context?: C) => R) | undefined, legacyTeamId: string | undefined): (event: E, context?: C) => R {
  if (company === undefined) return legacy;
  return (event, context) => (slackCompanyServes(event, legacyTeamId) ? company : legacy)(event, context);
}

type LinkCodes = { preview(personId: string, code: string): Promise<{ channel: string; maskedUserId: string } | undefined>; redeem(personId: string, code: string): Promise<unknown> };
/**
 * The link page's codes in the company handler: the company's own Slack codes first (the person's company decides the partition), then, only where the deployment has
 * registered channel adapters, the install's unscoped adapter codes exactly as the legacy handler serves them. One code space never reaches the other's rows.
 */
export function companyThenInstallLinkCodes<R>(company: LinkCodes, install: { preview(code: string): Promise<{ channel: string; maskedUserId: string } | undefined>; redeem(personId: string, code: string): Promise<R> } | undefined) {
  return {
    async preview(personId: string, code: string) {
      return await company.preview(personId, code) ?? (install === undefined ? undefined : await install.preview(code));
    },
    async redeem(personId: string, code: string) {
      if (install === undefined || await company.preview(personId, code) !== undefined) return company.redeem(personId, code) as Promise<R>;
      return install.redeem(personId, code);
    },
  };
}

/** The install's unscoped adapter codes, exactly as the legacy handler serves them (channel-links.ts), for companyThenInstallLinkCodes. */
export function installAdapterLinkCodes(links: ChannelLinkDependencies) {
  return { preview: (code: string) => previewLinkCode(links, code), redeem: (personId: string, code: string) => redeemLinkCode(links, personId, code) };
}
