// DEC 254o (b), L2-2 PR 18b: Slack company mode for every team but the install's own. The broker's company path (its `workspaces` dependency) is all-or-nothing, so the
// split is made per request, before any of it runs: a request for SLACK_TEAM_ID's team (or one naming no team) goes to a handler built WITHOUT `workspaces`, which is today's
// broker exactly; a request naming another team goes to the company handler. With no `workspaces` at all (the switch off) there is only today's handler.
// Choosing by a field the request carries is safe: each handler still checks the request in full (IAM for direct invokes, signatures and sign-in for HTTP), and the company
// handler's own binding checks decide what another team may do. Naming the install's team only ever selects today's checks.
import { IMPLICIT_COMPANY_ID, parseSlackThreadSubject } from "@agentx/contracts";
import { previewLinkCode, redeemLinkCode, type ChannelLinkDependencies } from "./channel-links.js";

/**
 * #1300: whether the install's own team is on the legacy path NOW. It is only while its workspace binding names the built-in company; bound to a named company (an operator
 * move, legacy-install-move.ts), the install's team is served like any other team, by the company path. A read binding is kept a minute per container. A
 * binding that cannot be read is not the legacy path, for that request only: the company path's own checks then refuse (fail closed).
 */
export function installTeamOnLegacyPath(companyOf: (teamId: string) => Promise<string | undefined>, teamId: string, now: () => number = Date.now): () => Promise<boolean> {
  let cached: { at: number; value: boolean } | undefined;
  return async () => {
    if (cached !== undefined && now() - cached.at < 60_000) return cached.value;
    try {
      const value = await companyOf(teamId) === IMPLICIT_COMPANY_ID;
      cached = { at: now(), value };
      return value;
    } catch {
      // Not kept: the next request reads the binding again.
      return false;
    }
  };
}

/** For a split: the legacy handler while the install's team is on the legacy path, else the company handler. Only asked for an event that names the install's team. */
function byInstallBinding<E, C, R>(legacy: (event: E, context?: C) => R, company: (event: E, context?: C) => R, onLegacy: () => Promise<boolean>): (event: E, context?: C) => R {
  return (event, context) => onLegacy().then((on) => (on ? legacy : company)(event, context)) as unknown as R;
}

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
export function withoutSlackCompanyMode<T extends { workspaces?: unknown; slackCompanies?: unknown; slackInstallTeamOnly?: string }>(dependencies: T, installTeamId?: string): T {
  const { workspaces: _company, slackCompanies: _members, ...legacy } = dependencies;
  void _company; void _members;
  // Defence in depth: in this view another team's channel binding is "not bound" (slackCompanyProject), whatever route names it.
  return (installTeamId === undefined ? legacy : { ...legacy, slackInstallTeamOnly: installTeamId }) as T;
}

/**
 * Two handlers, one per mode, built once; `company` undefined means the switch is off and `legacy` is today's handler, returned as it is. `installOnLegacy` (#1300): an event
 * naming the install's team takes the legacy handler only while that team is on the legacy path (installTeamOnLegacyPath); absent, it always does, as before.
 */
export function splitBySlackTeam<E, C, R>(legacy: (event: E, context?: C) => R, company: ((event: E, context?: C) => R) | undefined, legacyTeamId: string | undefined, installOnLegacy?: () => Promise<boolean>): (event: E, context?: C) => R {
  if (company === undefined) return legacy;
  const install = installOnLegacy === undefined ? legacy : byInstallBinding(legacy, company, installOnLegacy);
  return (event, context) => (slackCompanyServes(event, legacyTeamId) ? company : slackRequestTeam(event).named ? install : legacy)(event, context);
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

/**
 * L2-2 PR 18c: the team a Slack Lambda event names. Slack's own HTTP requests: the Events API's `team_id`, an interactivity payload's `team.id` (or its user's `team_id`), a
 * slash command's `team_id`. The Lambda's own hand-offs: `thread.teamId`, `teamId`, or a handed-off message's `actor.tenant`. `{ named: false }` when the event carries no team
 * field at all (url_verification, the channel API's adapter paths); a present but unreadable value is still named (team undefined), so it never reaches today's handler.
 */
export function slackIngressTeam(event: unknown): { named: false } | { named: true; team: string | undefined } {
  if (event === null || typeof event !== "object" || Array.isArray(event)) return { named: false };
  const value = event as { requestContext?: unknown; body?: unknown; isBase64Encoded?: unknown; thread?: unknown; teamId?: unknown; message?: unknown; event?: unknown };
  // Every team field present is collected; today's handler serves the event only if all of them name the install's team (a missing field is fine).
  const found: unknown[] = [];
  const object = (candidate: unknown): Record<string, unknown> | undefined => (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate) ? candidate as Record<string, unknown> : undefined);
  const field = (record: Record<string, unknown> | undefined, name: string) => { if (record !== undefined && name in record) found.push(record[name]); };
  const nested = (record: Record<string, unknown> | undefined, name: string, inner: string) => {
    if (record === undefined || !(name in record)) return;
    const child = object(record[name]);
    if (child === undefined) found.push(undefined); else field(child, inner);
  };
  const answer = (): { named: false } | { named: true; team: string | undefined } => {
    if (found.length === 0) return { named: false };
    const first = found[0];
    return { named: true, team: typeof first === "string" && found.every((team) => team === first) ? first : undefined };
  };
  if (value.requestContext === undefined) {
    // The Lambda's own hand-offs: thread.teamId, teamId, a handed-off message's actor.tenant (and conversation.tenant), a /rovara hand-off's event.teamId.
    const record = value as Record<string, unknown>;
    nested(record, "thread", "teamId");
    field(record, "teamId");
    const message = object(value.message);
    nested(message, "actor", "tenant");
    nested(message, "conversation", "tenant");
    nested(record, "event", "teamId");
    return answer();
  }
  if (value.body === undefined || value.body === null || value.body === "") return { named: false };
  if (typeof value.body !== "string" || value.body.length > 1_048_576) return { named: true, team: undefined };
  const body = value.isBase64Encoded === true ? Buffer.from(value.body, "base64").toString("utf8") : value.body;
  const fromObject = (parsed: unknown) => {
    const record = object(parsed);
    if (record === undefined) return { named: true as const, team: undefined };
    // Slack: the event's workspace, each authorization's installation, the context team; interactivity's team and user team. The channel API: the tenant fields.
    field(record, "team_id");
    field(record, "context_team_id");
    if ("authorizations" in record) {
      const list = record.authorizations;
      if (!Array.isArray(list)) found.push(undefined);
      else for (const entry of list) { const item = object(entry); if (item === undefined) found.push(undefined); else field(item, "team_id"); }
    }
    nested(record, "team", "id");
    nested(record, "user", "team_id");
    field(record, "tenant");
    nested(record, "conversation", "tenant");
    nested(record, "to", "tenant");
    return answer();
  };
  if (/^\s*[[{]/u.test(body)) {
    try { return fromObject(JSON.parse(body)); } catch { return { named: true, team: undefined }; }
  }
  try {
    const form = new URLSearchParams(body);
    const payload = form.get("payload");
    if (payload !== null) return fromObject(JSON.parse(payload));
    if (form.has("team_id")) found.push(form.get("team_id"));
    return answer();
  } catch { return { named: true, team: undefined }; }
}

/**
 * The Slack Lambda's two handlers. Fail closed: only an event naming no team, or exactly the install's team in every field, reaches today's handler; the install's team only
 * while it is on the legacy path (`installOnLegacy`, #1300; absent, always, as before).
 */
export function splitBySlackIngressTeam<E, R>(legacy: (event: E) => R, company: (event: E) => R, legacyTeamId: string, installOnLegacy?: () => Promise<boolean>): (event: E) => R {
  const install = installOnLegacy === undefined ? legacy : byInstallBinding(legacy, company, installOnLegacy);
  return (event) => {
    const found = slackIngressTeam(event);
    return (found.named ? (found.team !== legacyTeamId ? company : install) : legacy)(event);
  };
}
