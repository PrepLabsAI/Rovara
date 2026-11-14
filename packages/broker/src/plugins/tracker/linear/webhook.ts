// Port lane L2: the Linear pieces the Linear tracker adapter needs, in the adapter's own folder.
//
// Cloud's adapter imports three modules of the hosted product's trigger and Linear-close code (`triggers/providers/linear.ts`,
// `rovara-code/linear-close.ts`, `rovara-code/linear-comments.ts`). Those belong to the trigger framework (hidden since 2026-11-07) and to the
// session bindings, and they are not part of this lane. Everything the adapter takes from them is here instead, with the same rules:
//  - `normalizeIssueKey` is `linear-close.ts`'s, unchanged;
//  - `verifyLinearSignature` and `linearIssueCreated` are `linearProvider.verify` and the `Issue created` branch of `linearProvider.normalize`,
//    taking the hook's tenant as plain data (`LinearHook`) instead of Cloud's `HookRecord`.
// When the trigger framework is ported (L12 and later), the Linear provider there and this file must be reconciled so that one implementation
// remains (a decision-51 gap: the Linear webhook rules exist twice until then).
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** A Linear issue key: the team's key (a letter, then letters or digits, ten at most) and the issue's number. */
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9]{0,9}-[1-9][0-9]{0,8}$/u;

/** `text` as an issue key in capitals, or undefined when it is not one (a hostile or malformed value never reaches a description). */
export function normalizeIssueKey(text: string | undefined): string | undefined {
  return text !== undefined && ISSUE_KEY.test(text) ? text.toUpperCase() : undefined;
}

/** The Linear webhook an install registered: the project it is bound to and the Linear workspace and team it speaks for. */
export interface LinearHook {
  project: string;
  organizationId: string;
  teamId: string;
}

const digest = (value: string | Buffer): Buffer => createHash("sha256").update(value).digest();

/** `Linear-Signature` is the hex HMAC-SHA256 of the raw body under the webhook's signing secret. Compared as digests in constant time; an empty secret never verifies. */
export function verifyLinearSignature(raw: Buffer, headers: Readonly<Record<string, string | undefined>>, secret: string): boolean {
  let supplied = "";
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "linear-signature") continue;
    supplied = value ?? "";
    break;
  }
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  return timingSafeEqual(digest(supplied.trim().toLowerCase()), digest(expected)) && secret.length > 0;
}

export interface LinearIssueCreated {
  /** A stable name for the delivery's event: a redelivery has the same one. */
  eventKey: string;
  occurredAt: string;
  /** The issue's key as Linear shows it (`ENG-142`), or Linear's own id when it gave no key. */
  identifier: string;
  /** The issue's link: https on linear.app itself, or undefined. */
  url?: string;
  labels: string[];
  /** Linear's id of the account that made the issue, when the delivery names one. */
  actorId?: string;
}

export type LinearDelivery = { events: LinearIssueCreated[] } | { ignored: string } | { tenantMismatch: true };

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const Envelope = z.object({ type: z.string().max(64), action: z.string().max(64), organizationId: z.string().min(1).max(100) }).passthrough();
const TeamOf = z.object({ data: z.object({ teamId: z.string().min(1).max(100).optional(), team: z.object({ id: z.string().min(1).max(100).optional() }).passthrough().optional() }).passthrough() }).passthrough();
const Issue = z.object({
  webhookTimestamp: z.unknown(),
  url: z.unknown().optional(),
  actor: z.object({ id: z.string().min(1).max(200) }).passthrough().nullish(),
  data: z.object({
    id: z.string().min(1).max(100),
    identifier: z.string().min(1).max(100).optional(),
    number: z.number().int().positive().optional(),
    team: z.object({ key: z.string().min(1).max(50).optional() }).passthrough().optional(),
    url: z.unknown().optional(),
    labels: z.unknown().optional(),
  }).passthrough(),
}).passthrough();

/** `link` when it is a plain https link (no user name, password or port) on exactly `linear.app`; nothing otherwise. */
function linearLink(link: unknown): string | undefined {
  if (typeof link !== "string") return undefined;
  try {
    const url = new URL(link);
    return url.protocol === "https:" && url.hostname === "linear.app" && url.port === "" && url.username === "" && url.password === "" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** An instant given in milliseconds since 1970 (a number, or a numeral), as an ISO time; nothing for what is not a whole, representable number of them. */
function isoOfMillis(value: unknown): string | undefined {
  const millis = typeof value === "string" && /^\d{1,16}$/.test(value) ? Number(value) : value;
  if (typeof millis !== "number" || !Number.isSafeInteger(millis) || millis <= 0) return undefined;
  const at = new Date(millis);
  return Number.isFinite(at.getTime()) ? at.toISOString() : undefined;
}

/**
 * The issue-created events of a verified, parsed delivery. The organization is read first, from every kind of body: a delivery that is not the hook's Linear
 * organization is refused whatever it says it is. Only an `Issue` created becomes an event, and only for the hook's own team.
 */
export function linearIssueCreated(body: unknown, hook: LinearHook): LinearDelivery {
  const envelope = Envelope.safeParse(body);
  if (!envelope.success || !same(envelope.data.organizationId, hook.organizationId)) return { tenantMismatch: true };
  if (envelope.data.type !== "Issue" || envelope.data.action !== "create") return { ignored: "not an issue created" };
  const team = TeamOf.safeParse(body);
  const teamId = team.success ? (team.data.data.teamId ?? team.data.data.team?.id) : undefined;
  if (teamId === undefined || !same(teamId, hook.teamId)) return { tenantMismatch: true };
  const issue = Issue.safeParse(body);
  const occurredAt = issue.success ? isoOfMillis(issue.data.webhookTimestamp) : undefined;
  if (!issue.success || occurredAt === undefined) return { ignored: "an issue that can't be read" };
  const { data } = issue.data;
  const identifier = data.identifier ?? (data.team?.key !== undefined && data.number !== undefined ? `${data.team.key}-${String(data.number)}` : data.id);
  const labels = Array.isArray(data.labels)
    ? data.labels.map((label: unknown) => (label !== null && typeof label === "object" ? (label as { name?: unknown }).name : undefined)).filter((name): name is string => typeof name === "string" && name !== "").map((name) => name.slice(0, 200)).slice(0, 50)
    : [];
  const url = linearLink(data.url ?? issue.data.url);
  return {
    events: [{
      eventKey: `linear:issue:${data.id}:create`, occurredAt, identifier, labels, ...(url === undefined ? {} : { url }),
      ...(issue.data.actor === null || issue.data.actor === undefined ? {} : { actorId: issue.data.actor.id }),
    }],
  };
}
