// Guided onboarding PR 6 (design section 2, DEC 254l item 1): several repositories in one project, one project per repository (bulk), and the
// repository picker's read, for a sign-in client's signed-in Rovara administrator (POST /v1/dev/client/projects with `repositories`,
// POST /v1/dev/client/projects/bulk, GET /v1/dev/client/repositories/available). broker.ts builds and registers the projects; this module holds the
// company rules they share:
//   - ISOLATION: a repository is used only when GitHub says, at create time (an uncached lookup), which installation serves it, that installation is
//     not suspended, and its binding row (GITHUB_INSTALLATION#<id>/BINDING, read consistently) names the caller's company. The company is the live one
//     from membership (githubCallerCompany), never the body. Another company's installation, an unbound one, a suspended or removed one, and a
//     repository GitHub does not know all get the same answer, which names no repository and no cause.
//   - The picker marks a repository with the caller's company's projects only (its own catalog, ORG#<company>#PROJECT_CATALOG, and each project's
//     latest revision, kept only when that revision is the company's).
// Today's rule is kept: a repository may be in several projects of a company; the picker shows them so the person can choose.
import { AgentXError, errorStatus, orgProjectCatalogPk, type AgentXErrorCode, OrgIdSchema, PROJECT_CATALOG_PK, REPOSITORY_CHOICES_PAGE_DEFAULT, type BulkCreateClientProjectsResponse,
  type BulkProjectRefusal, type ClientRepositoriesResponse, type ClientRepositoryChoicesResponse } from "@agentx/contracts";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { recordInCompany, type boundedCompanyReads } from "./company-check.js";
import type { GithubInstallationBindings } from "./github-credentials.js";

/** The one answer for a repository the caller's company may not use (multi-repository create). Names no repository and no cause. */
export const REPOSITORIES_NOT_AVAILABLE = "one or more of these repositories is not available through your company's GitHub connection; nothing was created";
/** GitHub or the store could not be read for a repository the company may use. */
export const REPOSITORIES_UNAVAILABLE = "GitHub could not be reached for these repositories just now; nothing was created, try again";
/** The picker read could not be completed (never a partial list). */
export const REPOSITORY_CHOICES_UNAVAILABLE = "the repositories could not be read just now; try again";

/** How many repositories are looked up at once, how long a bulk create may start new projects, and how many it builds at once. */
export const LOOKUP_CONCURRENCY = 8;
export const BULK_DEADLINE_MS = 10_000;
/**
 * One wall-clock limit for a whole create request (API Gateway gives up at about 29 seconds): a project is registered only when its registration
 * starts within this many milliseconds of the request's start; later, nothing is written for it (multi: 503 unavailable; bulk: that row `unavailable`).
 * Registration itself is a few store reads and one transaction (its GitHub lookups are cached by then).
 */
export const COMMIT_DEADLINE_MS = 15_000;
export const BULK_CONCURRENCY = 4;
/** The most projects of one company the picker reads to mark repositories; a company with more is refused the marks whole (never a partial mark). */
export const PICKER_PROJECTS_MAX = 500;
const CATALOG_PAGE = 100;

type Budget = ReturnType<typeof boundedCompanyReads>;
/** GitHub's answer for the installation that serves a repository, read without a cache. */
export interface LiveRepositoryInstallation { installationId: number; suspended: boolean }

/** A create refused for a reason a bulk create reports per repository; as an error it is the HTTP answer of a one-project create. */
export class ClientProjectRefused extends AgentXError {
  constructor(readonly reason: Exclude<BulkProjectRefusal, "not_started">, code: AgentXErrorCode, message: string) {
    super(code, message, errorStatus(code));
  }
}
export const notAvailable = () => new ClientProjectRefused("not_available", "CONFIG_INVALID", REPOSITORIES_NOT_AVAILABLE);
export const unavailable = () => new ClientProjectRefused("unavailable", "RUNTIME_UNAVAILABLE", REPOSITORIES_UNAVAILABLE);
export const nameTaken = (name: string) => new ClientProjectRefused("name_taken", "CONFIG_INVALID", `a project named ${name} already exists; choose another name`);

/** The repository's name inside a project: what the single-repository create has always used. */
export function projectRepositoryName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").replace(/^([^a-z])/, "r-$1").slice(0, 63) || "repository";
}

/** Each repository's name in one project, unique: a repeated name gets -2, -3, ... (still at most 63 characters). */
export function uniqueRepositoryNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((raw) => {
    const base = projectRepositoryName(raw);
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base.slice(0, 63 - `-${n}`.length)}-${n}`;
    used.add(name);
    return name;
  });
}

/** Runs `work` on every item, at most `limit` at once; the first failure is thrown after the started ones settle. */
export async function eachLimited<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0; let failed: { error: unknown } | undefined;
  const worker = async () => {
    while (failed === undefined && next < items.length) {
      const index = next++;
      try { results[index] = await work(items[index]!, index); } catch (error) { failed ??= { error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed !== undefined) throw failed.error;
  return results;
}

export interface CompanyRepositoryRules {
  /** Absent: the install has no company bindings (the legacy single-company install), and no repository is refused for its company. */
  bindings?: GithubInstallationBindings;
  /** The uncached GitHub lookup. Absent while bindings are on: every repository is refused (fail closed). */
  live?: (url: string) => Promise<LiveRepositoryInstallation>;
}

/**
 * Whether every repository is on an active installation bound to `companyId`, read now. False when any one is not, or when anything could not be
 * read: the caller answers the same refusal either way. Every lookup shares `budget`.
 */
export async function onCompanyInstallations(rules: CompanyRepositoryRules, companyId: string | undefined, urls: readonly string[], budget: Budget): Promise<boolean> {
  if (rules.bindings === undefined) return true;
  const { bindings, live } = rules;
  if (companyId === undefined || !OrgIdSchema.safeParse(companyId).success || live === undefined) return false;
  const scoped = bindings.withBudget(budget);
  try {
    await eachLimited(urls, LOOKUP_CONCURRENCY, async (url) => {
      const found = await budget.read(() => live(url));
      if (found === null || typeof found !== "object" || found.suspended !== false || !Number.isSafeInteger(found.installationId) || found.installationId < 1) throw notAvailable();
      await scoped.requireBound(companyId, found.installationId);
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * One project per repository, each created by `create` (which throws ClientProjectRefused for a reason it knows; anything else is `unavailable`).
 * Repositories that would make the same project name are created one after another, so the second sees the first. A repository not started
 * before the deadline is `not_started`. Every repository gets exactly one row, in the order asked.
 */
export async function bulkCreate(repositories: readonly string[], options: {
  nameOf: (repository: string) => string; create: (repository: string) => Promise<string>; now: () => number; deadlineMs?: number; concurrency?: number;
}): Promise<BulkCreateClientProjectsResponse> {
  const started = options.now();
  const deadline = options.deadlineMs ?? BULK_DEADLINE_MS;
  const results: BulkCreateClientProjectsResponse["results"] = repositories.map((repository) => ({ repository, outcome: "refused", reason: "not_started" }));
  const groups = new Map<string, number[]>();
  repositories.forEach((repository, index) => {
    const name = options.nameOf(repository);
    groups.set(name, [...(groups.get(name) ?? []), index]);
  });
  await eachLimited([...groups.values()], options.concurrency ?? BULK_CONCURRENCY, async (indexes) => {
    for (const index of indexes) {
      if (options.now() - started >= deadline) return;
      const repository = repositories[index]!;
      try {
        results[index] = { repository, outcome: "created", project: await options.create(repository) };
      } catch (error) {
        results[index] = { repository, outcome: "refused", reason: error instanceof ClientProjectRefused ? error.reason : "unavailable" };
      }
    }
  });
  return { results };
}

/**
 * The company's projects that hold each repository (`owner/name`, lower case): its own catalog, then each project's latest revision, kept only when
 * that revision is the company's. Without a company (the legacy install) the install's catalog. Bounded; anything malformed or too large throws, so
 * no partial mark is ever shown.
 */
export async function projectsByRepository(store: { send(command: unknown): Promise<unknown> }, tableName: string, companyId: string | undefined, budget: Budget): Promise<Map<string, string[]>> {
  const pk = companyId === undefined ? PROJECT_CATALOG_PK : orgProjectCatalogPk(OrgIdSchema.parse(companyId));
  const names: string[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await budget.client.send(new QueryCommand({ TableName: tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": pk, ":prefix": "PROJECT#" }, Limit: CATALOG_PAGE, ConsistentRead: true, ...(cursor === undefined ? {} : { ExclusiveStartKey: cursor }) })) as { Items?: unknown[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const row of page.Items ?? []) {
      const sk = (row as { sk?: unknown; pk?: unknown }).sk;
      if ((row as { pk?: unknown }).pk !== pk || typeof sk !== "string" || !/^PROJECT#[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(sk)) throw new Error("catalog row unreadable");
      names.push(sk.slice("PROJECT#".length));
    }
    if (names.length > PICKER_PROJECTS_MAX) throw new Error("too many projects");
    cursor = page.LastEvaluatedKey;
  } while (cursor !== undefined);
  const marks = new Map<string, string[]>();
  await eachLimited(names, LOOKUP_CONCURRENCY, async (name) => {
    const latest = await budget.client.send(new QueryCommand({ TableName: tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :revision)",
      ExpressionAttributeValues: { ":pk": `PROJECT#${name}`, ":revision": "REV#" }, ScanIndexForward: false, Limit: 1, ConsistentRead: true })) as { Items?: unknown[] };
    const record = latest.Items?.[0] as { definition?: { name?: unknown; repositories?: unknown } } | undefined;
    // A catalog row whose project is missing or not the company's marks nothing.
    if (record === undefined || !recordInCompany(record, companyId) || record.definition?.name !== name || !Array.isArray(record.definition.repositories)) return;
    for (const repository of record.definition.repositories as Array<{ url?: unknown }>) {
      const key = typeof repository?.url === "string" ? /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i.exec(repository.url) : null;
      if (key === null) continue;
      const fullName = `${key[1]}/${key[2]}`.toLowerCase();
      const held = marks.get(fullName) ?? [];
      if (!held.includes(name)) marks.set(fullName, [...held, name]);
    }
  });
  for (const held of marks.values()) held.sort();
  return marks;
}

/** One page of the picker: the active installations' repositories, filtered by `q`, sorted by full name, after `after`, each with its marks. */
export function repositoryChoices(installations: ClientRepositoriesResponse["installations"], marks: ReadonlyMap<string, string[]>, query: { q?: string | undefined; limit?: number | undefined; after?: string | undefined }): ClientRepositoryChoicesResponse {
  const limit = query.limit ?? REPOSITORY_CHOICES_PAGE_DEFAULT;
  const q = query.q?.toLowerCase() ?? "";
  const after = query.after?.toLowerCase();
  const all = installations.filter((installation) => installation.status === "active").flatMap((installation) => installation.repositories.map((repository) => ({
    installationId: installation.installationId, accountLogin: installation.accountLogin, fullName: repository.fullName, githubRepositoryId: repository.githubRepositoryId,
    private: repository.private, defaultBranch: repository.defaultBranch, projects: [...(marks.get(repository.fullName.toLowerCase()) ?? [])],
  })));
  const chosen = all.filter((repository) => repository.fullName.toLowerCase().includes(q) && (after === undefined || repository.fullName.toLowerCase() > after))
    .sort((a, b) => a.fullName.toLowerCase() < b.fullName.toLowerCase() ? -1 : a.fullName.toLowerCase() > b.fullName.toLowerCase() ? 1 : a.installationId - b.installationId);
  const page = chosen.slice(0, limit);
  return {
    repositories: page,
    ...(chosen.length > limit ? { next: page.at(-1)!.fullName } : {}),
    incomplete: installations.some((installation) => installation.status === "active" && installation.repositories.length >= 100),
  };
}
