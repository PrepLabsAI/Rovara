// Guided onboarding PR 3 (designs-2026-10-30/guided-onboarding-design.md section 3a "Wrong org" and "Uninstalled or suspended"; DEC 254l item 2): the GitHub App installation's
// life after it is connected.
//
//   - GitHub's signed `installation` webhook (deleted, suspend, unsuspend) marks the binding's state (GithubInstallationBindings.markLifecycle): one conditional write with an audit
//     row (actor "github"), nothing deleted. The signature is checked first, by the same function the pull request webhooks use; an unsigned or forged event changes nothing. The
//     installation id alone finds the binding, so an event for one company's installation never touches another's. Other installation actions are acknowledged and ignored
//     (binding happens only by a person's claim, github-connect-routes.ts).
//   - Which of a company's projects use a repository on an installation (the disconnect route refuses while any does). Fail closed: a project that cannot be read counts as using it.
//   - GitHub's page where the installation itself is removed, for the disconnect answer.
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AgentXNameSchema, agentXError, companyLog, PROJECT_CATALOG_PK } from "@agentx/contracts";
import { parseGitHubRepository } from "../github-app.js";
import { verifyGithubWebhookSignature } from "../plugins/code-host/github/signature.js";
import { boundedCompanyReads, recordInCompany } from "./company-check.js";
import type { GithubInstallationBindings, LifecycleAction } from "./github-credentials.js";
import { GITHUB_WEBHOOK_SIGNATURE_INVALID, GithubWebhookRefusal, GithubWebhookRetryableError } from "./github-webhooks.js";

const DELIVERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MARKED_ACTIONS: ReadonlySet<string> = new Set<LifecycleAction>(["deleted", "suspend", "unsuspend"]);
/**
 * GitHub signs the body, not the X-GitHub-Event header: a body signed for another event must not pass as an installation event. So the body must have an installation event's
 * shape (the installation's account and the sender), none of another event's objects, and the account must be the binding's (checked in markLifecycle).
 */
const OTHER_EVENT_KEYS = ["comment", "issue", "pull_request", "review", "repository", "repositories_added", "repositories_removed", "check_run", "check_suite"];
const InstallationEvent = z.object({
  action: z.string().min(1).max(64),
  installation: z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), account: z.object({ login: z.string().min(1).max(256) }) }),
  sender: z.object({ login: z.string().min(1).max(256) }),
});

/** Whether a GitHub delivery is an `installation` event (the header picks the path; the signature over the body is checked before anything is read or written). */
export function isGithubInstallationEvent(headers: Record<string, string | undefined>): boolean {
  return Object.entries(headers).some(([key, value]) => key.toLowerCase() === "x-github-event" && value === "installation");
}

/**
 * One `installation` delivery. Order: size, signature (GITHUB_WEBHOOK_SIGNATURE_INVALID, so the route's secret re-read applies), delivery id, payload; then the mark. A storage
 * fault answers 503 (GitHub does not redeliver App webhooks on its own; an operator may redeliver it, and the delivery id keeps the mark single).
 * Known limit: deliveries are applied in arrival order, so a suspend and unsuspend that arrive reversed leave the binding suspended until a claim (fails safe: tasks refused). Answers ACCEPTED with the delivery id whatever the outcome, and logs ids only.
 */
export async function handleGithubInstallationWebhook(input: {
  rawBody: string;
  headers: Record<string, string | undefined>;
  secret: string;
  bindings: Pick<GithubInstallationBindings, "markLifecycle">;
  log: (entry: Record<string, unknown>) => void;
}): Promise<{ status: "ACCEPTED"; deliveryId: string }> {
  if (Buffer.byteLength(input.rawBody, "utf8") > 1_048_576) throw new GithubWebhookRefusal("GitHub webhook payload exceeds the size limit");
  const headers = Object.fromEntries(Object.entries(input.headers).map(([key, value]) => [key.toLowerCase(), value]));
  if (!verifyGithubWebhookSignature(input.rawBody, headers["x-hub-signature-256"], input.secret)) throw new GithubWebhookRefusal(GITHUB_WEBHOOK_SIGNATURE_INVALID);
  const deliveryId = headers["x-github-delivery"];
  if (deliveryId === undefined || !DELIVERY_ID.test(deliveryId)) throw new GithubWebhookRefusal("GitHub webhook delivery ID is invalid");
  let raw: unknown;
  try { raw = JSON.parse(input.rawBody) as unknown; } catch { throw new GithubWebhookRefusal("GitHub webhook JSON body is invalid"); }
  const event = InstallationEvent.safeParse(raw !== null && typeof raw === "object" && !Array.isArray(raw) && OTHER_EVENT_KEYS.some((key) => Object.hasOwn(raw, key)) ? undefined : raw);
  if (!event.success) throw new GithubWebhookRefusal("GitHub webhook event payload is unsupported or incomplete");
  if (!MARKED_ACTIONS.has(event.data.action)) return { status: "ACCEPTED", deliveryId };
  let outcome: Awaited<ReturnType<GithubInstallationBindings["markLifecycle"]>>;
  try { outcome = await input.bindings.markLifecycle(event.data.installation.id, event.data.action as LifecycleAction, deliveryId, event.data.installation.account.login); }
  catch { throw new GithubWebhookRetryableError("GitHub installation state could not be saved"); }
  if (outcome.outcome === "marked") {
    companyLog(outcome.companyId, input.log)({ event: "github.installation_marked", installationId: event.data.installation.id, from: outcome.from, to: outcome.to, actor: "github", deliveryId });
  }
  return { status: "ACCEPTED", deliveryId };
}

/** The most catalog entries one disconnect check examines (the install's catalog lists every company's projects); more refuses the disconnect (fail closed). */
export const PROJECT_SCAN_MAX = 400;
const CATALOG_PAGE = 100;
const READS_AT_ONCE = 8;

/**
 * Whether one stored repository entry is on the installation. A pin (the repository's or its host's `installationId`) decides alone. Without a pin, a GitHub repository whose
 * owner is the installation's account counts, unless `ownerElsewhere` (another of the company's ACTIVE installations has the same account, which then serves it). A repository
 * on another code host does not count. Anything that does not read counts (fail closed).
 */
export function repositoryUsesInstallation(repository: unknown, installation: { installationId: number; accountLogin: string; ownerElsewhere?: boolean }): boolean {
  if (repository === null || typeof repository !== "object" || Array.isArray(repository)) return true;
  const entry = repository as Record<string, unknown>;
  const host = entry["host"];
  if (host !== undefined && (host === null || typeof host !== "object" || Array.isArray(host))) return true;
  const hostRecord = host as Record<string, unknown> | undefined;
  if (hostRecord !== undefined && hostRecord["kind"] !== "github" && hostRecord["provider"] !== "github") return false;
  const pinned = hostRecord?.["installationId"] ?? entry["installationId"];
  if (pinned !== undefined) return pinned === installation.installationId;
  if (installation.ownerElsewhere === true) return false;
  if (typeof entry["url"] !== "string") return true;
  try { return parseGitHubRepository(entry["url"]).owner.toLowerCase() === installation.accountLogin.toLowerCase(); } catch { return true; }
}

/**
 * The names of `companyId`'s projects whose latest revision has a repository on the installation, sorted. Every project of the install's catalog is read, and only those whose
 * latest revision is in this company are kept (the same check the project page makes), so no other company's name is ever returned. One total read budget; past it, or past
 * PROJECT_SCAN_MAX entries, or on any unreadable row, it throws (the route refuses the disconnect).
 */
export async function projectsUsingInstallation(deps: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number }, companyId: string,
  installation: { installationId: number; accountLogin: string; ownerElsewhere?: boolean }): Promise<string[]> {
  const budget = boundedCompanyReads(deps.documentClient, deps.now);
  const names: string[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await budget.client.send(new QueryCommand({ TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": PROJECT_CATALOG_PK, ":prefix": "PROJECT#" }, ConsistentRead: true, Limit: CATALOG_PAGE,
      ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }) })) as { Items?: Array<{ sk?: unknown }>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      const name = typeof item.sk === "string" && item.sk.startsWith("PROJECT#") ? AgentXNameSchema.safeParse(item.sk.slice("PROJECT#".length)) : undefined;
      if (name?.success !== true) throw agentXError("RUNTIME_UNAVAILABLE", "projects unavailable");
      names.push(name.data);
    }
    if (names.length > PROJECT_SCAN_MAX) throw agentXError("RUNTIME_UNAVAILABLE", "projects unavailable");
    startKey = page.LastEvaluatedKey;
  } while (startKey !== undefined);
  const using: string[] = [];
  for (let index = 0; index < names.length; index += READS_AT_ONCE) {
    const batch = names.slice(index, index + READS_AT_ONCE);
    const latest = await Promise.all(batch.map(async (name) => {
      const response = await budget.client.send(new QueryCommand({ TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :rev)",
        ExpressionAttributeValues: { ":pk": `PROJECT#${name}`, ":rev": "REV#" }, ConsistentRead: true, ScanIndexForward: false, Limit: 1 })) as { Items?: unknown[] };
      return response.Items?.[0];
    }));
    batch.forEach((name, offset) => {
      const row = latest[offset];
      if (row === undefined || !recordInCompany(row, companyId)) return;
      const repositories = (row as { definition?: { repositories?: unknown } }).definition?.repositories;
      if (!Array.isArray(repositories) || repositories.some((repository) => repositoryUsesInstallation(repository, installation))) using.push(name);
    });
  }
  budget.check();
  return using.sort();
}

/**
 * GitHub's page where the installation itself is removed ("Uninstall"): an organization's settings page, or the person's own. A binding written before PR 3 does not know its
 * account type; the person's own settings address is given then (GitHub's installation settings).
 */
export function githubUninstallUrl(installationId: number, accountLogin: string, accountType?: "User" | "Organization"): string {
  return accountType === "Organization"
    ? `https://github.com/organizations/${encodeURIComponent(accountLogin)}/settings/installations/${installationId}`
    : `https://github.com/settings/installations/${installationId}`;
}
