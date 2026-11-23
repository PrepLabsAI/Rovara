// Webhook lane W0: the core branch of the GitHub webhook receiver. A VERIFIED delivery (the route has already checked its HMAC over the raw body) for a task the core owns does only this: find the task
// by what GitHub signed, and make that task's tracking row due sooner. It never calls GitHub, never believes a payload and stores no body, author or state: the sweep reads GitHub and decides.
//
// Order of work (nothing earlier may be skipped; a contract test pins it): parse and shape, the cheap action filter, the per-installation limit (memory), the mapping (READS only: installation -> company ->
// pull request / head -> link row -> task -> pinned repository -> tracking row), the durable per-installation limit, and only then the delivery reservation and the wake. A signed delivery that maps to nothing
// is answered 202 IGNORED with ZERO writes. A task the legacy engine owns goes back to the caller (`legacy`), unchanged.
//
// Fairness: one installation's flood cannot starve the others. (1) Everything before the mapping is cheap and reads nothing. (2) A per-installation fixed window in this container's memory refuses its
// excess before any read. (3) After the mapping, a durable per-installation window (all containers) refuses the excess before any write. (4) A delivery costs a fixed handful of DynamoDB operations and no
// GitHub request, so no tenant's volume reaches GitHub quota or the sweep's allowance. (5) The route's own throttle is global (infra, lane W3), so a flood beyond it degrades every tenant to the slow poll.
import { createHash } from "node:crypto";
import { DeleteCommand, GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { INDEX_EXPIRY_ATTRIBUTE, OrgIdSchema, prHeadKey, projectRevisionKey, type StoredDocument } from "@agentx/contracts";
import { findLinkedChangeRequest } from "../core/proof/revert/linked-change-requests.js";
import { codeHostRepositoryKey } from "../core/proof/revert/repository-key.js";
import { recoveryRowKey, taskRecordKey } from "../core/merge/store.js";
import { TRACKING_FAILURE_MAX_MS, TRACKING_POLL_MS } from "../services/merge-tracking.js";
import { entryOwner, readTaskStamp } from "./engine-boundary.js";
import { isConditional } from "./broker-shared.js";
import { recordInCompany } from "./company-check.js";
import { GithubWebhookRefusal } from "./github-webhooks.js";
import type { GithubInstallationBindings } from "./github-credentials.js";

/** Delivery and replay rows live this long (GitHub lets an operator redeliver for 3 days). */
export const GITHUB_DELIVERY_TTL_SECONDS = 7 * 86_400;
/** Per installation and minute: more accepted deliveries than this are answered THROTTLED with no effect. */
export const GITHUB_WEBHOOK_PER_MINUTE = 600;
const COUNTER_TTL_SECONDS = 600;
const HINT_ATTEMPTS = 5;

export const GITHUB_CORE_EVENTS = ["pull_request", "pull_request_review", "pull_request_review_comment", "pull_request_review_thread", "issue_comment", "check_suite", "check_run", "status"] as const;
export type GithubCoreEvent = typeof GITHUB_CORE_EVENTS[number];
export const isGithubCoreEvent = (name: string): name is GithubCoreEvent => (GITHUB_CORE_EVENTS as readonly string[]).includes(name);

/** Why a signed delivery did nothing (fixed words; the answer to GitHub carries none of them, only the metric does). */
export type GithubIgnoredReason = "malformed" | "unsupported_action" | "unknown_installation" | "installation_inactive" | "no_link" | "no_head" | "company_mismatch" | "task_ended"
  | "workflow_mismatch" | "repository_mismatch" | "no_row";

export type GithubCoreOutcome =
  | { kind: "legacy" }
  | { kind: "ignored"; reason: GithubIgnoredReason }
  | { kind: "throttled" }
  | { kind: "accepted"; deliveryId: string; wake: "woken" | "coalesced" | "no_row" }
  | { kind: "duplicate"; deliveryId: string };

type Client = { send(command: unknown): Promise<unknown> };
type Item = Record<string, unknown>;
type HintKind = "pull_request" | "review" | "comment" | "checks";
type DueField = "feedbackDueAt" | "checksDueAt";

export interface GithubCoreWebhookInput {
  documentClient: Client;
  tableName: string;
  bindings: Pick<GithubInstallationBindings, "ownerAndState">;
  rawBody: string;
  eventName: GithubCoreEvent;
  deliveryId: string;
  now: () => number;
  log: (entry: Record<string, unknown>) => void;
  perMinute?: number;
}

const Positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const Payload = z.object({
  action: z.string().max(80).optional(),
  installation: z.object({ id: Positive }).passthrough(),
  repository: z.object({ id: Positive, full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(300) }).passthrough(),
  pull_request: z.object({ number: Positive }).passthrough().optional(),
  issue: z.object({ number: Positive, pull_request: z.object({}).passthrough().optional() }).passthrough().optional(),
  check_suite: z.object({ head_sha: Sha }).passthrough().optional(),
  check_run: z.object({ head_sha: Sha }).passthrough().optional(),
  sha: Sha.optional(),
  state: z.string().max(40).optional(),
}).passthrough();
type ParsedPayload = z.infer<typeof Payload>;

const PULL_REQUEST_ACTIONS = new Set(["opened", "reopened", "edited", "closed", "synchronize", "ready_for_review", "converted_to_draft"]);
const REVIEW_ACTIONS = new Set(["submitted", "edited", "dismissed"]);
const COMMENT_ACTIONS = new Set(["created", "edited", "deleted"]);
const THREAD_ACTIONS = new Set(["resolved", "unresolved"]);

/** What a delivery says: which pull request or head to look at, what kind of hint it is, and which due field it raises. */
interface Hit { number?: number; sha?: string; kind: HintKind; due: DueField[] }

type Rule = (payload: ParsedPayload) => Hit | "malformed" | undefined;

/** A pull request event whose action is in `actions`: it names the pull request by number. */
const onPullRequest = (actions: Set<string>, kind: HintKind, due: (action: string) => DueField[]): Rule => (payload) => {
  if (payload.pull_request === undefined) return "malformed";
  const action = payload.action;
  return action !== undefined && actions.has(action) ? { number: payload.pull_request.number, kind, due: due(action) } : undefined;
};

/** A check suite or run that completed: it names a commit, which the company's head index maps to a pull request. */
const onCheck = (pick: (payload: ParsedPayload) => { head_sha: string } | undefined): Rule => (payload) => {
  const run = pick(payload);
  if (run === undefined) return "malformed";
  return payload.action === "completed" ? { sha: run.head_sha, kind: "checks", due: ["checksDueAt"] } : undefined;
};

const onIssueComment: Rule = (payload) => {
  if (payload.issue === undefined) return "malformed";
  const action = payload.action;
  return action !== undefined && COMMENT_ACTIONS.has(action) && payload.issue.pull_request !== undefined ? { number: payload.issue.number, kind: "comment", due: ["feedbackDueAt"] } : undefined;
};

const onStatus: Rule = (payload) => {
  if (payload.sha === undefined || payload.state === undefined) return "malformed";
  return payload.state === "pending" ? undefined : { sha: payload.sha, kind: "checks", due: ["checksDueAt"] };
};

/** The cheap action filter: only deliveries that can change what the sweep reads are kept. Undefined: nothing to do. */
const RULES: Record<GithubCoreEvent, Rule> = {
  pull_request: onPullRequest(PULL_REQUEST_ACTIONS, "pull_request", (action) => action === "synchronize" ? ["checksDueAt"] : []),
  pull_request_review: onPullRequest(REVIEW_ACTIONS, "review", () => ["feedbackDueAt"]),
  pull_request_review_comment: onPullRequest(COMMENT_ACTIONS, "comment", () => ["feedbackDueAt"]),
  // A thread resolved or reopened changes which comments still need an answer.
  pull_request_review_thread: onPullRequest(THREAD_ACTIONS, "comment", () => ["feedbackDueAt"]),
  issue_comment: onIssueComment,
  check_suite: onCheck((payload) => payload.check_suite),
  check_run: onCheck((payload) => payload.check_run),
  status: onStatus,
};
const hitOf = (event: GithubCoreEvent, payload: ParsedPayload): Hit | "malformed" | undefined => RULES[event](payload);

// ---- fairness (memory): one installation's excess is refused before any read

const windows = new Map<number, { minute: number; count: number }>();
const MAX_WINDOWS = 2_000;
/** True when this installation has used its minute in this container. Counts every verified delivery that gets this far. */
function overMemoryLimit(installationId: number, nowMs: number, limit: number): boolean {
  const minute = Math.floor(nowMs / 60_000);
  if (windows.size >= MAX_WINDOWS) for (const [id, window] of windows) if (window.minute !== minute) windows.delete(id);
  const window = windows.get(installationId);
  if (window === undefined || window.minute !== minute) { windows.set(installationId, { minute, count: 1 }); return false; }
  window.count += 1;
  return window.count > limit;
}

/** Forgets every installation's minute (tests; a new container starts with none). */
export function resetGithubWebhookWindows(): void { windows.clear(); }

// ---- the mapping (reads only)

const get = async (input: Pick<GithubCoreWebhookInput, "documentClient" | "tableName">, key: { pk: string; sk: string }): Promise<Item | undefined> =>
  ((await input.documentClient.send(new GetCommand({ TableName: input.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;

/** Adapts the table to the one read the link reader asks for. */
const linkStore = (input: Pick<GithubCoreWebhookInput, "documentClient" | "tableName">) => ({ get: async (key: { pk: string; sk: string }) => (await get(input, key)) as StoredDocument | undefined });

interface Mapped { taskId: string; companyId: string; installationId: number; repositoryId: number }

async function pinnedRepositoryKey(input: GithubCoreWebhookInput, companyId: string, task: Item, repositoryId: string): Promise<string | undefined> {
  if (typeof task["project"] !== "string" || typeof task["startingRevision"] !== "number") return undefined;
  const org = OrgIdSchema.safeParse(companyId);
  if (!org.success) return undefined;
  const revision = await get(input, projectRevisionKey(org.data, task["project"], task["startingRevision"]));
  const repositories = (revision?.["definition"] as { repositories?: unknown } | undefined)?.repositories;
  if (!Array.isArray(repositories)) return undefined;
  const pinned = repositories.find((entry: unknown) => (entry as { name?: unknown } | null)?.name === repositoryId) as { url?: unknown } | undefined;
  return typeof pinned?.url === "string" ? codeHostRepositoryKey("github", pinned.url) : undefined;
}

/** The linked pull request of a task is one the task's own workflow holds, with the same repository, number, address and checked code. */
function workflowHolds(task: Item, link: { repositoryId: string; number: number; url: string; candidateDigest: string }): boolean {
  const workflow = task["workflow"] as { stage?: unknown; pullRequests?: unknown } | undefined;
  return Array.isArray(workflow?.pullRequests) && (workflow.pullRequests as Array<Record<string, unknown>>).some((entry) =>
    entry["repositoryId"] === link.repositoryId && entry["number"] === link.number && entry["url"] === link.url && entry["candidateDigest"] === link.candidateDigest);
}

const taskEnded = (task: Item): boolean => task["closedAt"] !== undefined || task["releasedAt"] !== undefined || (task["workflow"] as { stage?: unknown } | undefined)?.stage === "CLOSED";

/** The pull request number a hit names: its own, or (a check or status event, which carries only a commit) the one the company's head index says. */
async function pullRequestOf(input: GithubCoreWebhookInput, companyId: string, repositoryKey: string, hit: Hit): Promise<{ number: number; taskId?: string } | GithubIgnoredReason> {
  if (hit.number !== undefined) return { number: hit.number };
  const org = OrgIdSchema.safeParse(companyId);
  if (!org.success || hit.sha === undefined) return "no_head";
  const head = await get(input, prHeadKey(org.data, repositoryKey, hit.sha));
  if (head === undefined || head["entityType"] !== "PR_HEAD" || head["orgId"] !== companyId || typeof head["taskId"] !== "string" || typeof head["number"] !== "number") return "no_head";
  return { number: head["number"], taskId: head["taskId"] };
}

/** The linked task, for this company: its record, its engine, its state, its workflow, its pinned repository and its tracking row. `legacy`: the task is the legacy engine's. */
async function mapTask(input: GithubCoreWebhookInput, companyId: string, repositoryKey: string, link: { taskId: string; repositoryId: string; number: number; url: string; candidateDigest: string }): Promise<GithubIgnoredReason | "legacy" | "ok"> {
  const task = await get(input, taskRecordKey(link.taskId));
  if (task === undefined || !recordInCompany(task, companyId)) return "company_mismatch";
  if (entryOwner(await readTaskStamp(input, link.taskId), "flow") !== "core") return "legacy";
  // A core task's company is stamped and must be exactly the installation's (no implicit fallback).
  if (task["companyId"] !== companyId) return "company_mismatch";
  if (taskEnded(task)) return "task_ended";
  if (!workflowHolds(task, link)) return "workflow_mismatch";
  if (await pinnedRepositoryKey(input, companyId, task, link.repositoryId) !== repositoryKey) return "repository_mismatch";
  const row = await get(input, recoveryRowKey(link.taskId));
  return row === undefined || row["kind"] !== "tracking" ? "no_row" : "ok";
}

/** installation -> company -> pull request -> link -> task, every step a read and every failure a reason. `legacy`: the task is the legacy engine's (or the installation is the old single-company one). */
async function map(input: GithubCoreWebhookInput, payload: ParsedPayload, hit: Hit): Promise<Mapped | GithubIgnoredReason | "legacy"> {
  const installation = await input.bindings.ownerAndState(payload.installation.id);
  if (installation.owner === undefined) return "unknown_installation";
  // The install's old single company has no binding row: only the legacy path serves it (no core wake is made on a guess of who owns what).
  if (!installation.bound) return "legacy";
  if (installation.state !== "active") return "installation_inactive";
  const companyId = installation.owner;
  const repositoryKey = codeHostRepositoryKey("github", `https://github.com/${payload.repository.full_name}`);
  if (repositoryKey === undefined) return "malformed";
  const found = await pullRequestOf(input, companyId, repositoryKey, hit);
  if (typeof found === "string") return found;
  const link = await findLinkedChangeRequest(linkStore(input), { hostKind: "github", repositoryAddress: `https://github.com/${payload.repository.full_name}`, id: String(found.number) });
  if (link === undefined) return "no_link";
  // A check or status event found its task by head; the pull request's link must name the same task.
  if (found.taskId !== undefined && found.taskId !== link.taskId) return "no_head";
  const verdict = await mapTask(input, companyId, repositoryKey, link);
  return verdict === "ok" ? { taskId: link.taskId, companyId, installationId: payload.installation.id, repositoryId: payload.repository.id } : verdict;
}

// ---- the writes (only after the mapping)

/** The durable per-installation window: counts one accepted delivery; true when the installation has already used its minute (the count never grows past the limit, the condition refuses it). */
async function overDurableLimit(input: GithubCoreWebhookInput, installationId: number, limit: number): Promise<boolean> {
  const minute = Math.floor(input.now() / 60_000);
  try {
    await input.documentClient.send(new UpdateCommand({
      TableName: input.tableName, Key: { pk: `GITHUB_RL#${installationId}#${minute}`, sk: "COUNT" },
      UpdateExpression: "ADD deliveries :one SET entityType = :entity, #ttl = :expires", ConditionExpression: "attribute_not_exists(deliveries) OR deliveries < :limit",
      ExpressionAttributeNames: { "#ttl": INDEX_EXPIRY_ATTRIBUTE },
      ExpressionAttributeValues: { ":one": 1, ":entity": "GITHUB_WEBHOOK_RATE", ":expires": (minute + 1) * 60 + COUNTER_TTL_SECONDS, ":limit": limit },
    }));
    return false;
  } catch (error) {
    if (isConditional(error)) return true;
    throw error;
  }
}

/** The delivery row and the body row in ONE transaction: the delivery id and the body (under any other id) are each seen once. The delivery row is COMPLETED at once and never enters the legacy recovery index. */
async function reserve(input: GithubCoreWebhookInput, mapped: Mapped, eventHash: string): Promise<"reserved" | "duplicate"> {
  const nowMs = input.now();
  const expires = Math.floor(nowMs / 1000) + GITHUB_DELIVERY_TTL_SECONDS;
  const at = new Date(nowMs).toISOString();
  const delivery = { pk: `GITHUB_DELIVERY#${input.deliveryId}`, sk: "META", entityType: "GITHUB_WEBHOOK_DELIVERY", companyId: mapped.companyId, deliveryId: input.deliveryId,
    installationId: mapped.installationId, repositoryId: mapped.repositoryId, eventHash, status: "COMPLETED", receivedAt: at, completedAt: at, core: true, [INDEX_EXPIRY_ATTRIBUTE]: expires };
  const body = { pk: `GITHUB_BODY#${eventHash}`, sk: "META", entityType: "GITHUB_WEBHOOK_BODY", companyId: mapped.companyId, installationId: mapped.installationId, receivedAt: at, [INDEX_EXPIRY_ATTRIBUTE]: expires };
  try {
    await input.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: input.tableName, Item: delivery, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: input.tableName, Item: body, ConditionExpression: "attribute_not_exists(pk)" } },
    ] }));
    return "reserved";
  } catch (error) {
    if (!isConditional(error)) throw error;
  }
  const stored = await get(input, { pk: `GITHUB_DELIVERY#${input.deliveryId}`, sk: "META" });
  // The same id with other content is a refusal (as on the legacy path); the same body under a fresh id, or the same delivery again, is a duplicate.
  if (stored !== undefined && (stored["eventHash"] !== eventHash || stored["installationId"] !== mapped.installationId || !recordInCompany(stored, mapped.companyId))) {
    throw new GithubWebhookRefusal("GitHub delivery ID was reused with different content");
  }
  return "duplicate";
}

/** Undoes a reservation whose wake failed, so GitHub's redelivery is not taken for a duplicate. Best effort: the slow poll covers what it cannot. */
async function release(input: GithubCoreWebhookInput, eventHash: string): Promise<void> {
  await input.documentClient.send(new DeleteCommand({ TableName: input.tableName, Key: { pk: `GITHUB_DELIVERY#${input.deliveryId}`, sk: "META" } })).catch(() => undefined);
  await input.documentClient.send(new DeleteCommand({ TableName: input.tableName, Key: { pk: `GITHUB_BODY#${eventHash}`, sk: "META" } })).catch(() => undefined);
}

const numeric = (row: Item, name: string, fallback = 0): number => typeof row[name] === "number" ? row[name] : fallback;

/** The update one hint makes to the row as read: its values, its set clauses, and the condition that the row's `lastHintAt` is still what was read. */
function hintUpdate(row: Item, now: number, hint: { kind: HintKind; due: readonly DueField[]; pollMs?: number }): { values: Record<string, unknown>; sets: string[]; condition: string } {
  const attempts = numeric(row, "attempts");
  const lastAttemptAt = numeric(row, "lastAttemptAt", typeof row["updatedAt"] === "string" ? Date.parse(row["updatedAt"]) || 0 : 0);
  const failureWait = attempts > 0 ? lastAttemptAt + Math.min((hint.pollMs ?? TRACKING_POLL_MS) * attempts, TRACKING_FAILURE_MAX_MS) : 0;
  const values: Record<string, unknown> = { ":next": Math.min(numeric(row, "nextAttemptAt", Number.MAX_SAFE_INTEGER), Math.max(now, failureWait)), ":zero": 0,
    ":hint": Math.max(numeric(row, "lastHintAt") + 1, now), ":kind": hint.kind, ":tracking": "tracking" };
  const sets = ["nextAttemptAt = :next", "quiet = :zero", "lastHintAt = :hint", "lastHintKind = :kind"];
  for (const field of hint.due) { values[`:${field}`] = Math.max(numeric(row, field), now); sets.push(`${field} = :${field}`); }
  const prior = row["lastHintAt"];
  if (typeof prior === "number") values[":prior"] = prior;
  return { values, sets, condition: `attribute_exists(pk) AND #kind = :tracking AND ${typeof prior === "number" ? "lastHintAt = :prior" : "attribute_not_exists(lastHintAt)"}` };
}

/**
 * The hint: makes the task's tracking row due sooner, and nothing else. Monotonic (`lastHintAt` and the due fields only grow, each hint at least 1 ms after the last, so a pass that read the row earlier
 * keeps the hint); coalescing (no per-task cap that skips a write: a compare-and-set on `lastHintAt`, retried, so two hints at once both land); a failing row is not made due before its failure wait is over.
 */
export async function hintTrackingRow(input: Pick<GithubCoreWebhookInput, "documentClient" | "tableName">, taskId: string, now: number, hint: { kind: HintKind; due: readonly DueField[]; pollMs?: number }): Promise<"woken" | "coalesced" | "no_row"> {
  const key = recoveryRowKey(taskId);
  for (let attempt = 0; attempt < HINT_ATTEMPTS; attempt += 1) {
    const row = await get(input, key);
    if (row === undefined || row["kind"] !== "tracking") return "no_row";
    const update = hintUpdate(row, now, hint);
    try {
      await input.documentClient.send(new UpdateCommand({ TableName: input.tableName, Key: key, UpdateExpression: `SET ${update.sets.join(", ")}`, ConditionExpression: update.condition,
        ExpressionAttributeNames: { "#kind": "kind" }, ExpressionAttributeValues: update.values }));
      return "woken";
    } catch (error) {
      if (!isConditional(error)) throw error;
    }
  }
  // Another hint won every round: it lowered `nextAttemptAt` and moved `lastHintAt` the same way, so the row is awake.
  return "coalesced";
}

// ---- the entry point

const refuse = (log: GithubCoreWebhookInput["log"], reason: GithubIgnoredReason, event: GithubCoreEvent): GithubCoreOutcome => {
  log({ event: "github_webhook.ignored", reason, hook: event });
  return { kind: "ignored", reason };
};

/** One verified delivery of a pull request, review, comment, check or status event. */
export async function receiveCoreGithubWebhook(input: GithubCoreWebhookInput): Promise<GithubCoreOutcome> {
  let raw: unknown;
  try { raw = JSON.parse(input.rawBody); } catch { return refuse(input.log, "malformed", input.eventName); }
  const parsed = Payload.safeParse(raw);
  if (!parsed.success) return refuse(input.log, "malformed", input.eventName);
  const hit = hitOf(input.eventName, parsed.data);
  if (hit === "malformed") return refuse(input.log, "malformed", input.eventName);
  if (hit === undefined) return refuse(input.log, "unsupported_action", input.eventName);
  const limit = input.perMinute ?? GITHUB_WEBHOOK_PER_MINUTE;
  if (overMemoryLimit(parsed.data.installation.id, input.now(), limit)) { input.log({ event: "github_webhook.rate_limited", where: "memory" }); return { kind: "throttled" }; }
  const mapped = await map(input, parsed.data, hit);
  if (mapped === "legacy") return { kind: "legacy" };
  if (typeof mapped === "string") return refuse(input.log, mapped, input.eventName);
  if (await overDurableLimit(input, mapped.installationId, limit)) { input.log({ event: "github_webhook.rate_limited", where: "table" }); return { kind: "throttled" }; }
  // GitHub signs the body, not X-GitHub-Event: the event name is bound into the replay identity, so a body signed for one event cannot be replayed as another.
  const eventHash = createHash("sha256").update(input.eventName, "utf8").update("\0").update(input.rawBody, "utf8").digest("hex");
  if (await reserve(input, mapped, eventHash) === "duplicate") {
    input.log({ event: "github_webhook.duplicate", hook: input.eventName });
    return { kind: "duplicate", deliveryId: input.deliveryId };
  }
  let wake: "woken" | "coalesced" | "no_row";
  try {
    wake = await hintTrackingRow(input, mapped.taskId, input.now(), { kind: hit.kind, due: hit.due });
  } catch (error) {
    await release(input, eventHash);
    throw error;
  }
  input.log({ event: "github_webhook.accepted", deliveryId: input.deliveryId, hook: input.eventName, ...(parsed.data.action === undefined ? {} : { action: parsed.data.action }), wake });
  return { kind: "accepted", deliveryId: input.deliveryId, wake };
}
