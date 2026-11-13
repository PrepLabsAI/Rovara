// The ONE list of paths that make a change risky, for the change tier (`change-tier.ts`). It is the union of the two lists the broker already had (`sensitive-paths.ts` for decision cards and
// `proof/risk.ts` for a pull request's risk), plus the folder names for auth, money, permissions and deletion or data loss. The two older callers are NOT repointed here: that would change the
// risk they show. They differ in exactly one pattern: the decision-card list also names other code hosts' pipeline files, while the risk list judges those separately (`CI_CONFIG_PATH_PATTERNS`,
// only for a fix, and `.github/workflows` is on both). The tier treats continuous-integration files as their own kind (`ci_file`, `CI_FILE_PATTERNS`), not as sensitive paths.
//
// Every match is made on a NORMALIZED path: Unicode compatibility form (so a full-width `ａｕｔｈ` is `auth`), `\` as `/`, no leading `./`, lower case. A directory name is a whole path segment (`src/author.ts`
// is not `auth`), and a file whose NAME is one of the words, or is made of one joined by `-`, `_` or `.` (`user-auth.ts`), is sensitive too, unless it is a document.

/** A path as the rules read it: one form, so a case or width trick cannot step round them. */
export function normalizedTierPath(path: string): string {
  const plain = path.normalize("NFKC").replace(/[\p{Cc}\p{Cf}]/gu, "").replaceAll("\\", "/").replace(/\/{2,}/gu, "/").replace(/^(?:\.\/)+/u, "").toLowerCase();
  // A name that ends in dots or spaces opens the same file on some systems (`AGENTS.md.`, `AGENTS.md `): read it without them. A segment of only dots (`..`) is left as it is.
  return plain.split("/").map((segment) => (/^\.+$/u.test(segment) ? segment : segment.replace(/[. ]+$/u, ""))).join("/");
}

/** The directory words that make everything under them sensitive. Auth, money, permissions, deletion and data loss, and the older lists' infrastructure words. */
const SENSITIVE_DIRECTORY_WORDS = [
  // auth
  "auth", "authn", "authz", "authentication", "authorization", "login", "oauth", "saml", "sso", "jwt", "mfa", "password", "passwords", "security", "crypto", "credentials", "secrets",
  // permissions and IAM
  "iam", "permissions", "permission", "policies", "rbac", "acl",
  // money
  "payments", "payment", "billing", "money", "invoices", "invoice", "checkout", "stripe", "ledger", "wallet",
  // deletion and data loss
  "migrations", "delete", "deletion", "erase", "purge", "retention",
  // where the code runs
  "infra", "terraform", "cdk",
] as const;
const SENSITIVE_DIRECTORY = new RegExp(`(^|/)(${SENSITIVE_DIRECTORY_WORDS.join("|")})(/|$)`, "u");

/** The words that make a file sensitive when its name is one, or is made of one joined to others by `-`, `_` or `.`; `author.ts` and `secretsanta.ts` are not. */
const SENSITIVE_NAME_WORDS: ReadonlySet<string> = new Set(["auth", "authn", "authz", "security", "oauth", "saml", "sso", "jwt", "crypto", "permissions", "credentials", "secrets", "iam", "rbac", "billing", "payments", "payment"]);
/** Documents about a topic are not code for it (but a document UNDER a sensitive folder is still sensitive). */
const DOCUMENT_EXTENSIONS = /\.(md|mdx|markdown|txt|rst|adoc)$/u;

/** Files and folders that decide who must approve, how a branch is protected, how the project works, and what is built or deleted. Not CI files: those are `ci_file`. */
const SENSITIVE_FILE_PATTERNS: readonly RegExp[] = [
  // Who must approve and how a branch is protected: a change to them changes the rules every later merge follows.
  /(^|\/)codeowners$/u,
  // How the project works (the playbook file) and what its meta repository configures.
  /(^|\/)\.rovara\/(playbook|project)\.(ya?ml|json)$/u,
  /(^|\/)\.github\/(settings\.ya?ml|rulesets?(\/|$)|branch[-_]protection[^/]*)$/u,
  // Data shape and where the code is built and runs.
  /\.(sql|tf)$/u,
  /(^|\/)dockerfile(\.[^/]*)?$/u,
  // Dependabot and renovate decide which updates arrive without a person asking.
  /(^|\/)\.github\/(dependabot|renovate)\.(ya?ml|json)$/u,
];

/** The paths of continuous-integration configuration: their own kind (`ci_file`), checked by a reviewer for leaked secrets. Normalized paths. */
export const CI_FILE_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.github\/workflows\//u,
  /(^|\/)\.gitlab-ci\.ya?ml$/u,
  /(^|\/)\.circleci\//u,
  /(^|\/)buildspec[^/]*\.ya?ml$/u,
  /(^|\/)jenkinsfile[^/]*$/u,
  /(^|\/)azure-pipelines\.ya?ml$/u,
  /(^|\/)\.buildkite\//u,
  /(^|\/)bitbucket-pipelines\.ya?ml$/u,
  /(^|\/)\.gitlab\//u,
];

export function isCiFilePath(path: string): boolean {
  const value = normalizedTierPath(path);
  return CI_FILE_PATTERNS.some((pattern) => pattern.test(value));
}

/** Whether a path has a segment, or a file name, that makes it sensitive. */
export function isTierSensitivePath(path: string): boolean {
  const value = normalizedTierPath(path);
  if (SENSITIVE_DIRECTORY.test(value) || SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(value))) return true;
  const name = value.split("/").at(-1) ?? "";
  return !DOCUMENT_EXTENSIONS.test(name) && name.split(/[-_.]/u).some((word) => SENSITIVE_NAME_WORDS.has(word));
}

/**
 * Files that tell an AI agent what to do, and the folders that hold prompts and templates: a change to one changes what every later task is told, so it always gets full planning.
 * Matched on any path depth, on the normalized path.
 */
const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /(^|\/)(agents|claude|gemini|skill|copilot-instructions|cursorrules|windsurfrules|clinerules)\.md$/u,
  /(^|\/)\.(cursorrules|windsurfrules|clinerules)$/u,
  /(^|\/)\.cursor\//u,
  /(^|\/)\.claude\//u,
  /(^|\/)\.codex\//u,
  /(^|\/)\.agents\//u,
  /(^|\/)\.windsurf\//u,
  /(^|\/)\.continue\//u,
  /(^|\/)\.github\/(copilot-instructions\.md|instructions\/|prompts\/|chatmodes\/)/u,
  /(^|\/)\.rovara\//u,
  // Prompt and template folders, and prompt files by name.
  /(^|\/)(prompts?|templates?|\.prompts?)\//u,
  /(^|\/)[^/]*\.prompt(\.[^/]*)?$/u,
];

export function isInstructionPath(path: string): boolean {
  const value = normalizedTierPath(path);
  return INSTRUCTION_PATTERNS.some((pattern) => pattern.test(value));
}

/** Folders that run code on their own when git operates: hooks. Whole path segments, also under `.git`. */
const HOOK_PATTERNS: readonly RegExp[] = [/(^|\/)\.git(\/|$)/u, /(^|\/)\.githooks\//u, /(^|\/)\.husky\//u];
export const isHookPath = (path: string): boolean => HOOK_PATTERNS.some((pattern) => pattern.test(normalizedTierPath(path)));
