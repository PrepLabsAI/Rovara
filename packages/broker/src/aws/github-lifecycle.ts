// Guided onboarding PR 3 (designs-2026-10-30/guided-onboarding-design.md section 3a "Wrong org" and "Uninstalled or suspended"; DEC 254l item 2): the GitHub App installation's
// life after it is connected.
//
//   - GitHub's signed `installation` webhook (deleted, suspend, unsuspend) marks the binding's state (GithubInstallationBindings.markLifecycle): one conditional write with an audit
//     row (actor "github"), nothing deleted. The signature is checked first, by the same function the pull request webhooks use; an unsigned or forged event changes nothing. The
//     installation id alone finds the binding, so an event for one company's installation never touches another's. Other installation actions are acknowledged and ignored
//     (binding happens only by a person's claim, github-connect-routes.ts).
//   - DEC 254zc(1): GitHub's signed `installation_repositories` (added, removed) and `repository` (transferred) webhooks mark a repository the company can no longer reach
//     (GithubInstallationBindings.markRepositories / clearRepositories): one mark per company and full name in the company's own partition, found by the installation id alone. The
//     project setup-status read shows it on the repos row. Same signature check, same shape guard (a body signed for another event, resent under this header, writes nothing).
//   - Which of a company's projects use a repository on an installation (the disconnect route refuses while any does). Fail closed: a project that cannot be read counts as using it.
//   - GitHub's page where the installation itself is removed, for the disconnect answer.
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AgentXNameSchema, agentXError, companyLog, PROJECT_CATALOG_PK } from "@agentx/contracts";
import { parseGitHubRepository } from "../github-app.js";
import { verifyGithubWebhookSignature } from "../plugins/code-host/github/signature.js";
import { boundedCompanyReads, recordInCompany } from "./company-check.js";
import { REPOSITORY_MOVES_MAX, repositoryFullName, type GithubInstallationBindings, type LifecycleAction } from "./github-credentials.js";
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

/** The other events' objects: none may be in a repository-list body. `repositories` is the `installation` event's own list. */
const OTHER_REPOSITORY_EVENT_KEYS = ["comment", "issue", "pull_request", "review", "check_run", "check_suite", "repositories"];
const RepositoryListed = z.object({ full_name: repositoryFullName });
const RepositoriesEvent = z.object({
  action: z.enum(["added", "removed"]),
  installation: z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), account: z.object({ login: z.string().min(1).max(256) }) }),
  sender: z.object({ login: z.string().min(1).max(256) }),
  repositories_added: z.array(RepositoryListed).optional(),
  repositories_removed: z.array(RepositoryListed).optional(),
}).passthrough();
const OwnerName = z.string().regex(/^[A-Za-z0-9_.-]+$/).max(100);
const RepositoryEvent = z.object({
  action: z.string().min(1).max(64),
  installation: z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).passthrough(),
  sender: z.object({ login: z.string().min(1).max(256) }),
  repository: z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+$/).max(200) }).passthrough(),
}).passthrough();
const TransferChanges = z.object({ changes: z.object({ owner: z.object({ from: z.object({
  user: z.object({ login: OwnerName }).passthrough().optional(), organization: z.object({ login: OwnerName }).passthrough().optional() }).passthrough() }).passthrough() }).passthrough() });

/**
 * Whether a GitHub delivery belongs to the installation's life: `installation`, `installation_repositories` or `repository` (the header picks the path; the signature over the body is
 * checked before anything is read or written). Other events go to the pull request webhook as before.
 */
export function isGithubInstallationEvent(headers: Record<string, string | undefined>): boolean {
  return Object.entries(headers).some(([key, value]) => key.toLowerCase() === "x-github-event" && (value === "installation" || value === "installation_repositories" || value === "repository"));
}

const hasKey = (raw: unknown, keys: readonly string[]): boolean => raw !== null && typeof raw === "object" && !Array.isArray(raw) && keys.some((key) => Object.hasOwn(raw, key));
type LifecycleBindings = Pick<GithubInstallationBindings, "markLifecycle" | "markRepositories" | "clearRepositories">;

/**
 * One installation-life delivery: `installation` (deleted, suspend, unsuspend mark the binding), `installation_repositories` (removed marks, added clears the company's repository marks) or
 * `repository` (transferred marks the old name). Order: size, signature (GITHUB_WEBHOOK_SIGNATURE_INVALID, so the route's secret re-read applies), delivery id, payload; then the write. A storage
 * fault answers 503 (GitHub does not redeliver App webhooks on its own; an operator may redeliver it, and the delivery id keeps a binding mark single; a repository mark is a plain overwrite).
 * Known limit: deliveries are applied in arrival order, so a suspend and unsuspend that arrive reversed leave the binding suspended until a claim (fails safe: tasks refused), and a repository
 * "removed" arriving after its "added" leaves the mark until the next "added" (a mark is also left when the App is reinstalled; it is display only). Answers ACCEPTED with the delivery id whatever the outcome, and logs ids and counts only.
 */
export async function handleGithubInstallationWebhook(input: {
  rawBody: string;
  headers: Record<string, string | undefined>;
  secret: string;
  bindings: LifecycleBindings;
  log: (entry: Record<string, unknown>) => void;
}): Promise<{ status: "ACCEPTED"; deliveryId: string }> {
  if (Buffer.byteLength(input.rawBody, "utf8") > 1_048_576) throw new GithubWebhookRefusal("GitHub webhook payload exceeds the size limit");
  const headers = Object.fromEntries(Object.entries(input.headers).map(([key, value]) => [key.toLowerCase(), value]));
  if (!verifyGithubWebhookSignature(input.rawBody, headers["x-hub-signature-256"], input.secret)) throw new GithubWebhookRefusal(GITHUB_WEBHOOK_SIGNATURE_INVALID);
  const deliveryId = headers["x-github-delivery"];
  if (deliveryId === undefined || !DELIVERY_ID.test(deliveryId)) throw new GithubWebhookRefusal("GitHub webhook delivery ID is invalid");
  let raw: unknown;
  try { raw = JSON.parse(input.rawBody) as unknown; } catch { throw new GithubWebhookRefusal("GitHub webhook JSON body is invalid"); }
  if (headers["x-github-event"] === "installation_repositories") return handleRepositoriesListed(input, raw, deliveryId);
  if (headers["x-github-event"] === "repository") return handleRepositoryTransferred(input, raw, deliveryId);
  const event = InstallationEvent.safeParse(hasKey(raw, OTHER_EVENT_KEYS) ? undefined : raw);
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

/** `installation_repositories`: removed marks each listed repository for the installation's company; added clears its marks. The body must have this event's shape and the account must be the binding's. */
async function handleRepositoriesListed(input: { bindings: LifecycleBindings; log: (entry: Record<string, unknown>) => void }, raw: unknown, deliveryId: string): Promise<{ status: "ACCEPTED"; deliveryId: string }> {
  const parsed = RepositoriesEvent.safeParse(hasKey(raw, [...OTHER_REPOSITORY_EVENT_KEYS, "repository"]) ? undefined : raw);
  if (!parsed.success) throw new GithubWebhookRefusal("GitHub webhook event payload is unsupported or incomplete");
  const event = parsed.data;
  const listed = event.action === "removed" ? event.repositories_removed : event.repositories_added;
  if (listed === undefined) throw new GithubWebhookRefusal("GitHub webhook event payload is unsupported or incomplete");
  // Marking more than the limit refuses the whole delivery (never a part of it). Clearing is safe at any size (the body is capped at 1 MB), so it goes in chunks of the limit.
  if (event.action === "removed" && listed.length > REPOSITORY_MOVES_MAX) throw new GithubWebhookRefusal("GitHub webhook names too many repositories");
  const names = [...new Set(listed.map((entry) => entry.full_name.toLowerCase()))];
  if (names.length === 0) return { status: "ACCEPTED", deliveryId };
  const account = event.installation.account.login;
  try {
    if (event.action === "removed") {
      const outcome = await input.bindings.markRepositories(event.installation.id, names.map((fullName) => ({ fullName, reason: "removed" as const })), deliveryId, account);
      if (outcome.outcome === "marked") companyLog(outcome.companyId, input.log)({ event: "github.repositories_marked", installationId: event.installation.id, reason: "removed", count: outcome.count, actor: "github", deliveryId });
    } else {
      for (let from = 0; from < names.length; from += REPOSITORY_MOVES_MAX) {
        const chunk = names.slice(from, from + REPOSITORY_MOVES_MAX);
        const outcome = await input.bindings.clearRepositories(event.installation.id, chunk, deliveryId, account);
        if (outcome.outcome === "cleared") companyLog(outcome.companyId, input.log)({ event: "github.repositories_cleared", installationId: event.installation.id, count: outcome.count, actor: "github", deliveryId });
      }
    }
  } catch { throw new GithubWebhookRetryableError("GitHub repository state could not be saved"); }
  return { status: "ACCEPTED", deliveryId };
}

/**
 * `repository` transferred (GitHub sends it to the account the repository moved to): the old name, from the event's own `changes.owner.from`, is marked "transferred" for the installation's company.
 * Any other `repository` action is acknowledged and ignored. The body must have this event's shape; the new owner must be the binding's account.
 */
async function handleRepositoryTransferred(input: { bindings: LifecycleBindings; log: (entry: Record<string, unknown>) => void }, raw: unknown, deliveryId: string): Promise<{ status: "ACCEPTED"; deliveryId: string }> {
  const parsed = RepositoryEvent.safeParse(hasKey(raw, [...OTHER_REPOSITORY_EVENT_KEYS, "repositories_added", "repositories_removed"]) ? undefined : raw);
  if (!parsed.success) throw new GithubWebhookRefusal("GitHub webhook event payload is unsupported or incomplete");
  const event = parsed.data;
  if (event.action !== "transferred") return { status: "ACCEPTED", deliveryId };
  const changes = TransferChanges.safeParse(raw);
  const owner = z.object({ owner: z.object({ login: OwnerName }).passthrough() }).safeParse(event.repository);
  const from = changes.success ? [changes.data.changes.owner.from.user?.login, changes.data.changes.owner.from.organization?.login].filter((login): login is string => login !== undefined) : [];
  if (from.length !== 1 || !owner.success) throw new GithubWebhookRefusal("GitHub webhook event payload is unsupported or incomplete");
  try {
    const outcome = await input.bindings.markRepositories(event.installation.id, [{ fullName: `${from[0]}/${event.repository.name}`, reason: "transferred" }], deliveryId, owner.data.owner.login);
    if (outcome.outcome === "marked") companyLog(outcome.companyId, input.log)({ event: "github.repositories_marked", installationId: event.installation.id, reason: "transferred", count: outcome.count, actor: "github", deliveryId });
  } catch { throw new GithubWebhookRetryableError("GitHub repository state could not be saved"); }
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
