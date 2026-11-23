// Lane P5a (DEC 435 delta D1, D6): a repository whose packages cannot be installed because they live in a PRIVATE registry and Rovara holds no usable token for it.
//
// Such a repository is not broken and not failed: it is read and edited, never tested, and a person adds a package token and runs setup again. This file holds only the SERVED shapes and the fixed
// words, so the worker (detector), the broker (setup coverage) and the app read one definition. Browser-safe: it imports only zod.
//
// What is never here: a token, a command, a line of install output. Only a registry host name, package scope names and two fixed words (`missing`, `refused`).
import { z } from "zod";

/** `missing`: no token is stored for that registry. `refused`: a token is stored and the registry still said 401 / 403 / hid the package (wrong, expired or too narrow). */
export const PACKAGE_KEY_DETAILS = ["missing", "refused"] as const;
export type PackageKeyDetail = (typeof PACKAGE_KEY_DETAILS)[number];

/** The state is bounded like the setup coverage digest bounds it: at most this many scopes, each one npm scope name. */
export const PACKAGE_KEY_SCOPES_MAX = 8 as const;
export const PACKAGE_KEY_HOST_PATTERN = /^[a-z0-9][a-z0-9.-]{0,252}$/u;
export const PACKAGE_KEY_SCOPE_PATTERN = /^@[a-z0-9][a-z0-9._-]{0,63}$/u;

/**
 * Registries Rovara knows NEED a token for every read, even of a package that is public to the org's members: GitHub Packages answers 401 without one. A repository that routes a scope to such a host
 * with no company token stored is `untested` before any install is tried (zero cost). Other private hosts are found only after one install attempt fails.
 */
export const PACKAGE_KEY_KNOWN_HOSTS: Readonly<Record<string, { name: string }>> = { "npm.pkg.github.com": { name: "GitHub Packages" } };

export const PackageKeyUntestedSchema = z.object({
  state: z.literal("untested"),
  reason: z.literal("needs_package_key"),
  detail: z.enum(PACKAGE_KEY_DETAILS),
  registryHost: z.string().regex(PACKAGE_KEY_HOST_PATTERN, "a registry host name"),
  scopes: z.array(z.string().regex(PACKAGE_KEY_SCOPE_PATTERN, "a package scope")).max(PACKAGE_KEY_SCOPES_MAX),
}).strict();
/** The served state of one untested repository (setupCoverage[repo], D1.1). */
export type PackageKeyUntested = z.infer<typeof PackageKeyUntestedSchema>;

/** Scope names of any source: kept only when they are valid scope names, deduplicated, sorted, at most the bound. Sorted so the same facts always make the same digest. */
export function normalizePackageKeyScopes(scopes: Iterable<string>): string[] {
  const valid = new Set<string>();
  for (const scope of scopes) if (PACKAGE_KEY_SCOPE_PATTERN.test(scope)) valid.add(scope);
  return [...valid].sort().slice(0, PACKAGE_KEY_SCOPES_MAX);
}

export function packageKeyUntested(detail: PackageKeyDetail, registryHost: string, scopes: Iterable<string>): PackageKeyUntested {
  return { state: "untested", reason: "needs_package_key", detail, registryHost, scopes: normalizePackageKeyScopes(scopes) };
}

// ---- the quiet reminder card (D6)

/** The plain sentence of D6.1. One repo: "<repo> needs a package token to install and test." Several: "<a>, <b> need a package token to install and test." */
export function packageKeySentence(repos: readonly string[]): string {
  return `${repos.join(", ")} ${repos.length === 1 ? "needs" : "need"} a package token to install and test.`;
}

export const PACKAGE_KEY_REMINDER_REPOS_MAX = 200 as const;
const repoName = z.string().min(1).max(200).regex(/^[^\p{Cc}\p{Cf}]*$/u, "one plain line");

export const PackageKeyReminderRepoSchema = z.object({ repo: repoName, projectId: z.string().min(1).max(200).optional(), sentence: z.string().min(1).max(400) }).strict();
/**
 * ONE quiet card per company and registry host. NOT a Needs-you item: no count, no badge, no notification (the three flags are the fixed value `false` so a screen cannot turn one on by reading them).
 * Cloud renders it; the words come from here.
 */
export const PackageKeyReminderSchema = z.object({
  kind: z.literal("package_key_reminder"),
  companyId: z.string().min(1).max(200),
  registryHost: z.string().regex(PACKAGE_KEY_HOST_PATTERN),
  scopes: z.array(z.string().regex(PACKAGE_KEY_SCOPE_PATTERN)).max(PACKAGE_KEY_SCOPES_MAX),
  /** `refused` when any listed repository's token was rejected; `missing` when none is stored. */
  detail: z.enum(PACKAGE_KEY_DETAILS),
  repos: z.array(PackageKeyReminderRepoSchema).min(1).max(PACKAGE_KEY_REMINDER_REPOS_MAX),
  sentence: z.string().min(1).max(PACKAGE_KEY_REMINDER_REPOS_MAX * 210),
  needsYou: z.literal(false),
  badge: z.literal(false),
  notification: z.literal(false),
}).strict();
export type PackageKeyReminder = z.infer<typeof PackageKeyReminderSchema>;

export interface PackageKeyReminderInput { companyId: string; projectId?: string | undefined; repo: string; state: PackageKeyUntested }

const byText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

function reminderOf(companyId: string, registryHost: string, rows: readonly PackageKeyReminderInput[]): PackageKeyReminder {
  const repos = rows.map((row) => ({ repo: row.repo, ...(row.projectId === undefined ? {} : { projectId: row.projectId }), sentence: packageKeySentence([row.repo]) }))
    .sort((left, right) => byText(left.repo, right.repo) || byText(left.projectId ?? "", right.projectId ?? "")).slice(0, PACKAGE_KEY_REMINDER_REPOS_MAX);
  return {
    kind: "package_key_reminder",
    companyId,
    registryHost,
    scopes: normalizePackageKeyScopes(rows.flatMap((row) => row.state.scopes)),
    detail: rows.some((row) => row.state.detail === "refused") ? "refused" : "missing",
    repos,
    sentence: packageKeySentence([...new Set(repos.map((row) => row.repo))]),
    needsYou: false,
    badge: false,
    notification: false,
  };
}

/** The reminder cards for a set of untested repositories: one per (company, registry host), however many projects and repositories need it. A repository listed twice for one project counts once. */
export function buildPackageKeyReminders(inputs: readonly PackageKeyReminderInput[]): PackageKeyReminder[] {
  const groups = new Map<string, Map<string, PackageKeyReminderInput>>();
  for (const input of inputs) {
    const groupKey = JSON.stringify([input.companyId, input.state.registryHost]);
    const group = groups.get(groupKey) ?? new Map<string, PackageKeyReminderInput>();
    group.set(JSON.stringify([input.projectId ?? "", input.repo]), input);
    groups.set(groupKey, group);
  }
  return [...groups.values()].map((group) => {
    const rows = [...group.values()];
    return reminderOf(rows[0]!.companyId, rows[0]!.state.registryHost, rows);
  }).sort((left, right) => byText(left.companyId, right.companyId) || byText(left.registryHost, right.registryHost));
}
