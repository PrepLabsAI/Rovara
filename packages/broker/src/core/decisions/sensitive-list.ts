// The ONE list of paths that decide the change tier (`change-tier.ts`). It is the union of the two lists the broker already had (`sensitive-paths.ts` for decision cards and `proof/risk.ts` for a pull request's
// risk), widened to words in file names and to the places where code runs on its own or an agent is told what to do. The two older callers are NOT repointed here: that would change the risk they show.
//
// A deny-list always leaks, so the tier is decided the other way round: a path is LOW only when it is on an allowlist (a recognised source extension or a known config file, outside every area named here). Everything this
// file names, and every file type it does not know, goes up. Every match is made on a skeleton of the path: Unicode compatibility form, look-alike letters (Cyrillic and Greek) mapped to Latin, control and zero-width
// characters dropped, `\` as `/`, no leading `./`, lower case, no trailing dots or spaces.

/** Letters from other scripts that read as a Latin letter in a path. A path that holds one is never matched on the look-alike: it is risky by itself. */
const CONFUSABLES: ReadonlyMap<string, string> = new Map(Object.entries({
  "а": "a", "в": "b", "с": "c", "ԁ": "d", "е": "e", "һ": "h", "і": "i", "ј": "j", "к": "k", "ӏ": "l", "м": "m", "н": "h", "о": "o", "р": "p", "ԛ": "q", "г": "r", "ѕ": "s", "т": "t", "ս": "u", "ѵ": "v", "ѡ": "w", "х": "x", "у": "y", "ᴢ": "z",
  "α": "a", "β": "b", "γ": "y", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "ɑ": "a", "ɡ": "g", "ı": "i", "ӊ": "h",
  "А": "a", "В": "b", "С": "c", "Е": "e", "Н": "h", "І": "i", "Ј": "j", "К": "k", "М": "m", "О": "o", "Р": "p", "Ѕ": "s", "Т": "t", "Х": "x", "У": "y",
  "Α": "a", "Β": "b", "Ε": "e", "Ζ": "z", "Η": "h", "Ι": "i", "Κ": "k", "Μ": "m", "Ν": "n", "Ο": "o", "Ρ": "p", "Τ": "t", "Υ": "y", "Χ": "x",
}));

/** A path with its letters folded to one form but its CASE kept (camelCase words are read from this form): width, script, invisible characters, separators. */
export function foldedTierPath(path: string): string {
  return [...path.normalize("NFKC").replace(/[\p{Cc}\p{Cf}]/gu, "")].map((char) => CONFUSABLES.get(char) ?? char).join("")
    .replaceAll("\\", "/").replace(/\/{2,}/gu, "/").replace(/^(?:\.\/)+/u, "");
}

/** A path as the rules read it: one form, so a case, width, script or invisible-character trick cannot step round them. */
export function normalizedTierPath(path: string): string {
  const plain = foldedTierPath(path).toLowerCase();
  // A name that ends in dots or spaces opens the same file on some systems (`AGENTS.md.`, `AGENTS.md `): read it without them. A segment of only dots (`..`) is left as it is.
  return plain.split("/").map((segment) => (/^\.+$/u.test(segment) ? segment : segment.replace(/[. ]+$/u, ""))).join("/");
}

/** Whether a path holds a letter of another script that looks like a Latin one (`аuth` with a Cyrillic а). */
export function hasConfusableLetter(path: string): boolean {
  return [...path.normalize("NFKC")].some((char) => CONFUSABLES.has(char));
}

/** Characters that reorder text on screen (Trojan Source): the code a person reads is not the code that runs. */
export const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/u;
/** Whether a line has a word that mixes ASCII letters with a letter that merely looks like one (`isAdmіn` with a Cyrillic і): the name is not the one it seems. */
export function hasMixedScriptWord(text: string): boolean {
  return (text.normalize("NFKC").match(/[\p{L}\p{N}_$]+/gu) ?? []).some((word) => /[A-Za-z]/u.test(word) && [...word].some((char) => CONFUSABLES.has(char)));
}

/** Whether a path holds any letter outside ASCII (after width folding): no map of look-alikes is ever complete, so in a code path such a letter is risky by itself. */
export function hasNonAsciiLetter(path: string): boolean {
  return /[^\p{ASCII}]/u.test(path.normalize("NFKC").replace(/[\p{Cc}\p{Cf}]/gu, ""));
}

// ---- words in names

/**
 * The words of one path segment: split on `-`, `_`, `.`, spaces and camelCase (`deleteAccount`, `signIn`) BEFORE any lower-casing, a plural read as its singular. Two neighbouring words are also joined (`sign` and `in` give `signin`,
 * `api` and `key` give `apikey`). Pass the segment of the case-kept form (`foldedTierPath`), not a lower-cased one.
 */
export function wordsOf(segment: string): string[] {
  const plain = foldedTierPath(segment);
  const words = plain.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2").split(/[\s\-_.]+/u).map((word) => word.toLowerCase()).filter((word) => word.length > 0)
    .map((word) => (word.length > 3 && word.endsWith("ies") ? `${word.slice(0, -3)}y` : word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word));
  return [...words, ...words.slice(1).map((word, index) => `${words[index]!}${word}`)];
}

/** The words that make a folder or a file sensitive: auth, money, permissions, deletion and data loss, and where the code runs. Singular forms; `wordsOf` reads a plural as one. */
const SENSITIVE_WORDS: ReadonlySet<string> = new Set([
  // auth
  "auth", "authn", "authz", "authentication", "authorization", "login", "logout", "signin", "signup", "oauth", "saml", "sso", "jwt", "mfa", "otp", "password", "passwd", "passphrase", "security", "crypto", "credential",
  "secret", "token", "session", "cookie", "keychain", "certificate", "apikey", "accesskey", "privatekey", "secretkey", "signin", "signup", "signout", "authorize", "authenticate", "totp", "hotp", "webauthn", "passkey", "csrf", "xsrf",
  "signature", "verify", "impersonate", "impersonation", "sudo", "encrypt", "encryption", "decrypt", "decryption", "cipher", "pbkdf", "bcrypt", "argon", "oidc", "openid", "kerberos", "ldap",
  // permissions and IAM
  "iam", "permission", "policy", "policie", "rbac", "acl", "role", "privilege", "entitlement", "approval", "approve",
  // money
  "payment", "billing", "money", "invoice", "checkout", "stripe", "paypal", "ledger", "wallet", "refund", "charge", "payout", "pricing", "subscription", "plan", "coupon",
  // deletion and data loss
  "delete", "deletion", "erase", "purge", "retention", "destroy", "wipe", "truncate", "migrate", "migration", "removeuser", "removeaccount", "removemember", "removeteam", "deleteuser", "gdpr",
  // where the code runs
  "infra", "terraform", "cdk",
]);

/** The words that are not a sensitive word in a FILE NAME of a document (a page about a topic is not code for it), but still are as a folder. */
const DOCUMENT_EXTENSIONS = /\.(md|mdx|markdown|txt|rst|adoc)$/u;

/** Folders that hold schema changes: any folder with `migrat` in its name, Rails' `db/migrate`, alembic's `versions`, prisma's `migrations`. */
const MIGRATION_FOLDERS: readonly RegExp[] = [/(^|\/)[^/]*migrat[^/]*(\/|$)/u, /(^|\/)alembic\/versions(\/|$)/u, /(^|\/)db\/(migrate|schema)(\/|$)/u, /(^|\/)(flyway|liquibase)(\/|$)/u];

/** Files and folders that decide who must approve, how a branch is protected, how the project works, and what is built or deleted. */
const SENSITIVE_FILE_PATTERNS: readonly RegExp[] = [
  /(^|\/)codeowners$/u,
  /(^|\/)\.rovara\/(playbook|project)\.(ya?ml|json)$/u,
  /(^|\/)\.github\/(settings\.ya?ml|rulesets?(\/|$)|branch[-_]protection[^/]*)$/u,
  /\.sql$/u,
  /(^|\/)\.github\/(dependabot|renovate)\.(ya?ml|json)$/u,
  /(^|\/)\.?renovate(rc)?(\.json5?)?$/u, /(^|\/)\.github\/renovate\.json5?$/u,
  // What merges without a person: a change to them changes who looks at every later change.
  /(^|\/)\.?(mergify|kodiak|bors)(\.ya?ml|\.toml)$/u, /(^|\/)\.github\/(mergify\.ya?ml|auto_merge[\w.]*|CODEOWNERS)$/u,
];

/** Whether a path is sensitive: a sensitive word as a folder, or as a word of a file name (not of a document's name), a migration folder, or one of the named files. Words are read with their camelCase kept. */
export function isTierSensitivePath(path: string): boolean {
  const value = normalizedTierPath(path);
  if (SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(value)) || MIGRATION_FOLDERS.some((pattern) => pattern.test(value))) return true;
  const segments = foldedTierPath(path).split("/");
  const name = segments.at(-1) ?? "";
  for (const folder of segments.slice(0, -1)) if (wordsOf(folder).some((word) => SENSITIVE_WORDS.has(word))) return true;
  return !DOCUMENT_EXTENSIONS.test(name.toLowerCase()) && wordsOf(name.replace(/\.[^.]*$/u, "")).some((word) => SENSITIVE_WORDS.has(word));
}

// ---- infrastructure, files that run on their own, agent configuration

/** Where the code is built, deployed or provisioned: a change reaches production without a code review of what it does. */
const INFRA_PATTERNS: readonly RegExp[] = [
  /(^|\/)(dockerfile|containerfile)[^/]*$/u, /\.(dockerfile|containerfile)$/u,
  /\.(tf|tfvars|tf\.json|tfvars\.json|hcl|nomad|bicep|tfstate)$/u, /(^|\/)(terragrunt|packer)[^/]*\.hcl$/u, /(^|\/)(terraform|\.terraform)(\/|$)/u,
  /(^|\/)(k8s|kubernetes|helm|manifests|kustomize|ansible|pulumi|cdk\.out)(\/|$)/u, /(^|\/)(kustomization|chart)\.ya?ml$/u, /(^|\/)pulumi\.[^/]*\.ya?ml$/u,
  /(^|\/)(serverless|docker-compose[^/]*|compose|samconfig|skaffold|fly|app)\.(ya?ml|toml)$/u, /(^|\/)(cdk\.json|procfile|vercel\.json|netlify\.toml|render\.ya?ml|appspec\.ya?ml|buildspec[^/]*\.ya?ml)$/u,
  /(^|\/)(infra|infrastructure|deploy|deployment|deployments)(\/|$)/u,
  // Scripts that ship or provision: the name says so even when the folder does not.
  /(^|\/)(deploy|release|publish|provision|bootstrap|rollout|rollback|ship|promote)[\w.-]*\.(sh|bash|zsh|ps1|py|rb|js|mjs|ts)$/u,
  // CDK stacks, Helm charts and values, deploy descriptors, and the rules that guard a hosted database or bucket.
  /(^|\/)lib\/[^/]*stack[^/]*\.[cm]?[jt]s$/u, /[^/]*[-_.]stack\.[cm]?[jt]s$/u, /(^|\/)charts\//u, /(^|\/)values[\w.-]*\.ya?ml$/u,
  /(^|\/)(firestore|storage|database)\.rules(\.json)?$/u, /\.rules$/u, /(^|\/)supabase\//u, /(^|\/)firebase\.json$/u,
  /(^|\/)(wrangler\.(toml|jsonc?)|devfile\.ya?ml|sam\/[^/]*\.ya?ml|template\.ya?ml|stack\.ya?ml|app\.ya?ml|nixpacks\.toml|railway\.(json|toml))$/u,
];
export const isInfraPath = (path: string): boolean => INFRA_PATTERNS.some((pattern) => pattern.test(normalizedTierPath(path)));

/** Files that run on their own when a person opens the folder, commits, or enters the directory, or that pull code from another place when they do. */
const SELF_RUNNING_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.git(\/|$)/u, /(^|\/)\.githooks\//u, /(^|\/)\.husky\//u, /(^|\/)(lefthook|\.lefthook)[^/]*\.ya?ml$/u, /(^|\/)\.pre-commit(-config|-hooks)?\.ya?ml$/u, /(^|\/)\.overcommit\.yml$/u,
  /(^|\/)\.vscode\//u, /(^|\/)\.devcontainer(\/|\.json$)/u, /(^|\/)devcontainer\.json$/u, /(^|\/)\.gitpod\.ya?ml$/u, /(^|\/)\.codespaces\//u, /(^|\/)\.idea\//u, /(^|\/)\.zed\//u,
  /(^|\/)\.lfsconfig$/u, /(^|\/)\.envrc$/u, /(^|\/)\.?mise\.toml$/u, /(^|\/)\.mise\//u, /(^|\/)\.tool-versions$/u, /(^|\/)\.devbox\//u, /(^|\/)devbox\.json$/u, /(^|\/)\.direnv\//u,
  /(^|\/)\.(gitpod|devcontainer)\.[\w.]*$/u, /(^|\/)\.gitpod\//u, /(^|\/)\.tasks?\.json$/u, /(^|\/)\.cargo\/config(\.toml)?$/u,
  /(^|\/)gradle\/wrapper\//u, /(^|\/)gradlew(\.bat)?$/u, /(^|\/)mvnw(\.cmd)?$/u, /(^|\/)\.mvn\//u,
];
export const isHookPath = (path: string): boolean => SELF_RUNNING_PATTERNS.some((pattern) => pattern.test(normalizedTierPath(path)));

/** Files that tell an AI agent what to do, and the folders that hold prompts, skills and templates: a change to one changes what every later task is told. Any path depth. */
const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /(^|\/)(agents?|claude|gemini|warp|skill|copilot-instructions|cursorrules|windsurfrules|clinerules|codex|conventions|llms(-full)?)\.(md|mdx|txt|ya?ml|json)$/u,
  /(^|\/)\.(cursorrules|cursorignore|windsurfrules|clinerules|aiderignore|aider\.conf\.ya?ml|aider\.[\w.-]+|geminiignore|claudeignore|codeiumignore)$/u,
  /(^|\/)\.?(mcp|mcp\.[\w-]+)\.json$/u,
  /(^|\/)\.(cursor|claude|codex|agents?|windsurf|continue|gemini|amazonq|kiro|roo|cline|clinerules|aider|trae|junie|opencode|qwen|goose|augment|zed|copilot|openhands|kilocode|warp|cody|tabnine|codeium|sourcegraph|replit|bolt|lovable|v0)\//u,
  /(^|\/)\.github\/(copilot-instructions\.md|instructions\/|prompts\/|chatmodes\/|agents\/)/u,
  /(^|\/)\.rovara\//u,
  // Skill folders and agent steering: they tell an agent what to do. (Product prompt files are NOT here: they are judged by behaviour, see `isPromptHintPath`.)
  /(^|\/)(skills?|steering|chatmodes?)\//u,
];

/**
 * Product prompt files: a prompt or template folder, a prompt in the file name, a system message. They are NOT risky by name (owner decision: prompt files are judged by what they do, not what they are called): they follow
 * the ordinary size rules, and the tier carries an `eval_hint` reason so that the evaluation check (TE-F4) can be run on them until it has been measured. Agent-instruction files stay risky (`isInstructionPath`).
 */
const PROMPT_HINT_PATTERNS: readonly RegExp[] = [
  /(^|\/)(prompts?|templates?|\.prompts?)\//u,
  /(^|\/)[^/]*prompt[^/]*\.(md|mdx|txt|ya?ml|json|toml|jinja2?|j2|hbs|mustache|tmpl|tpl|liquid)$/u,
  /(^|\/)[^/]*\.prompt(\.[^/]*)?$/u,
];
const PROMPT_HINT_WORDS: ReadonlySet<string> = new Set(["prompt", "systemmessage", "systemprompt", "systeminstruction", "metaprompt", "preprompt", "llm"]);
export function isPromptHintPath(path: string): boolean {
  const value = normalizedTierPath(path);
  if (PROMPT_HINT_PATTERNS.some((pattern) => pattern.test(value))) return true;
  if (!INSTRUCTION_LIKE_EXTENSIONS.test(value)) return false;
  return foldedTierPath(path).split("/").some((segment) => wordsOf(segment.replace(/\.[^.]*$/u, "")).some((word) => PROMPT_HINT_WORDS.has(word)));
}

/** Prose and config files that name an agent, a skill, an instruction or an MCP server in the NAME or a folder (not code: `src/agent/runner.ts` is code). */
const INSTRUCTION_WORDS: ReadonlySet<string> = new Set(["agent", "skill", "instruction", "steering", "persona", "mcp", "claude", "gemini", "copilot", "llms", "guardrail", "openhands", "kilocode"]);
const INSTRUCTION_LIKE_EXTENSIONS = /\.(md|mdx|markdown|rst|adoc|txt|ya?ml|json|toml)$/u;

export function isInstructionPath(path: string): boolean {
  const value = normalizedTierPath(path);
  if (INSTRUCTION_PATTERNS.some((pattern) => pattern.test(value))) return true;
  if (!INSTRUCTION_LIKE_EXTENSIONS.test(value)) return false;
  return foldedTierPath(path).split("/").some((segment) => wordsOf(segment.replace(/\.[^.]*$/u, "")).some((word) => INSTRUCTION_WORDS.has(word)));
}

// ---- continuous integration

/** The paths of continuous-integration configuration (and the files that run the same commands): their own kind (`ci_file`), checked by a reviewer for leaked secrets. Normalized paths. */
export const CI_FILE_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.(github|gitea|forgejo|gitee)\/(workflows|actions)\//u, /(^|\/)\.(gitea|forgejo)\/[^/]*\.ya?ml$/u, /(^|\/)action\.ya?ml$/u,
  /(^|\/)\.gitlab-ci\.ya?ml$/u,
  /(^|\/)\.circleci\//u,
  /(^|\/)buildspec[^/]*\.ya?ml$/u,
  /(^|\/)jenkinsfile[^/]*$/u,
  /(^|\/)azure-pipelines[^/]*\.ya?ml$/u,
  /(^|\/)\.buildkite\//u,
  /(^|\/)bitbucket-pipelines\.ya?ml$/u,
  /(^|\/)\.gitlab\//u,
  /(^|\/)\.(travis|appveyor|drone|woodpecker)\.ya?ml$/u, /(^|\/)\.woodpecker\//u,
  /(^|\/)cloudbuild[^/]*\.ya?ml$/u,
  /(^|\/)(gnumakefile|makefile|justfile|taskfile\.ya?ml|build\.sbt|noxfile\.py|tox\.ini)$/u,
];
export function isCiFilePath(path: string): boolean {
  const value = normalizedTierPath(path);
  return CI_FILE_PATTERNS.some((pattern) => pattern.test(value));
}

/** The test runners' and security scanners' own configuration: deleting or weakening one changes what is checked. */
const CHECK_CONFIG_PATTERNS: readonly RegExp[] = [
  /(^|\/)(vitest|jest|playwright|karma|cypress|mocha|ava|tap)[^/]*\.(config|workspace)\.[cm]?[jt]s(on)?$/u, /(^|\/)\.mocharc(\.[\w]+)?$/u, /(^|\/)(pytest\.ini|conftest\.py|setup\.cfg|\.coveragerc|\.nycrc[\w.]*)$/u,
  /(^|\/)(\.snyk|\.gitleaks\.toml|\.gitleaksignore|\.semgrep[\w.]*|semgrep\.ya?ml|\.trivyignore|\.codeql[\w.-]*|sonar-project\.properties|\.bandit|\.safety-policy\.ya?ml|\.secrets\.baseline|\.trufflehog[\w.]*)$/u,
  /(^|\/)\.github\/codeql\//u, /(^|\/)(\.eslintrc[\w.]*|eslint\.config\.[cm]?[jt]s)$/u,
  // Linters and scanners for security: a rule turned off here is a hole in every later change.
  /(^|\/)(\.golangci[\w.-]*\.ya?ml|\.bandit|bandit\.ya?ml|\.?ruff\.toml|\.semgrep[\w.-]*|semgrep[\w.-]*\.ya?ml|gosec[\w.-]*\.json|\.brakeman[\w.-]*|brakeman\.ya?ml|detekt[\w.-]*\.ya?ml|\.hadolint\.ya?ml|\.tflint\.hcl|\.checkov[\w.-]*|\.pylintrc|\.flake8|\.safety-policy\.ya?ml|trivy\.ya?ml|\.snyk)$/u,
];

/** Files that tell a linter or scanner what to skip: an addition here switches a check off for those paths. */
export const SCANNER_IGNORE_PATTERN = /(^|\/)\.(eslint|semgrep|bandit|stylelint|hadolint|trivy|snyk|pylint|flake8|ruff|golangci|codeql|gitleaks|checkov|safety|brakeman)[\w.-]*ignore$/u;
export const isScannerIgnorePath = (path: string): boolean => SCANNER_IGNORE_PATTERN.test(normalizedTierPath(path));

/** The configuration of a documentation build: it runs code (hooks, plugins, extensions) when the site is built, so a change to it is not a document change. */
const DOCS_BUILD_CONFIG: readonly RegExp[] = [
  /(^|\/)docusaurus\.config\.[\w.]+$/u, /(^|\/)mkdocs\.ya?ml$/u, /(^|\/)(docs?\/)?conf\.py$/u, /(^|\/)\.vitepress\//u, /(^|\/)book\.toml$/u, /(^|\/)_config\.ya?ml$/u,
  /(^|\/)hugo\.(toml|ya?ml|json)$/u, /(^|\/)astro\.config\.[\w.]+$/u, /(^|\/)antora(-playbook)?\.ya?ml$/u, /(^|\/)\.readthedocs\.ya?ml$/u, /(^|\/)gatsby-config\.[\w.]+$/u, /(^|\/)sidebars\.[\w.]+$/u,
  /(^|\/)typedoc\.json$/u, /(^|\/)\.storybook\//u, /(^|\/)doxyfile$/u, /(^|\/)docs?\/[^/]*hooks?[^/]*\.py$/u,
];
export const isDocsBuildConfigPath = (path: string): boolean => DOCS_BUILD_CONFIG.some((pattern) => pattern.test(normalizedTierPath(path)));
/** Paths whose existence at the head means the repository builds a documentation site: a document in it may be compiled or executed by the build. */
export const DOCS_SITE_PROBES: readonly string[] = [
  "docusaurus.config.js", "docusaurus.config.ts", "docusaurus.config.mjs", "mkdocs.yml", "mkdocs.yaml", "docs/conf.py", "conf.py", "docs/source/conf.py", ".vitepress/config.ts", ".vitepress/config.js", ".vitepress/config.mts", "docs/.vitepress/config.ts",
  "docs/.vitepress/config.mts", "hugo.toml", "hugo.yaml", "astro.config.mjs", "astro.config.ts", "next.config.js", "next.config.mjs", "book.toml", "_config.yml", "antora-playbook.yml", ".readthedocs.yml", ".readthedocs.yaml",
  "gatsby-config.js", "typedoc.json", "Doxyfile",
];
export const isCheckConfigPath = (path: string): boolean => CHECK_CONFIG_PATTERNS.some((pattern) => pattern.test(normalizedTierPath(path)));

// ---- shape of an API

/** Files that define what an API or a stored record looks like: a change reaches every caller. At least standard. */
const API_SHAPE_PATTERNS: readonly RegExp[] = [
  /(^|\/)schema\.prisma$/u, /(^|\/)(openapi|swagger|asyncapi)[^/]*\.(ya?ml|json)$/u, /\.(proto|graphql|gql|avsc|thrift|smithy|capnp|fbs)$/u,
  /(^|\/)(schemas?|serializers?|dtos?)(\/|\.[a-z]+$)/u, /(^|\/)[\w.-]*\.(schema|dto)\.[a-z]+$/u, /(^|\/)(api|apis)\/[^/]*\.(ya?ml|json)$/u,
];
export const isApiShapePath = (path: string): boolean => API_SHAPE_PATTERNS.some((pattern) => pattern.test(normalizedTierPath(path)));

// ---- what a file is

/** Recognised source code, markup and style files. A file of any other type is at least standard: the classifier does not know what it does. */
const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "py", "pyi", "java", "kt", "kts", "go", "rs", "rb", "cs", "cpp", "cc", "cxx", "c", "h", "hpp", "swift", "scala", "php", "lua", "dart", "ex", "exs", "erl", "clj", "hs", "ml", "r", "jl", "m",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "css", "scss", "sass", "less", "html", "htm", "vue", "svelte", "astro", "mdx", "svg", "ejs", "hbs",
]);
/** Recognised data and configuration extensions. */
const CONFIG_EXTENSIONS = new Set(["json", "json5", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "conf", "xml", "properties", "gradle", "csproj", "props", "lock", "csv", "env"]);
export const PROSE_EXTENSIONS = new Set(["md", "markdown", "rst", "adoc", "txt"]);
/** Known extensionless and dot files that are plain configuration. */
const KNOWN_CONFIG_NAMES = /^(?:\.gitignore|\.dockerignore|\.npmignore|\.eslintignore|\.prettierignore|\.editorconfig|\.nvmrc|\.node-version|\.python-version|\.ruby-version|\.browserslistrc|\.babelrc[\w.]*|\.prettierrc[\w.]*|\.eslintrc[\w.]*|\.stylelintrc[\w.]*|\.swcrc|\.flake8|\.pylintrc|\.rubocop\.ya?ml|\.gitkeep|\.nojekyll|license[\w.-]*|notice|authors|contributors|codeowners|makefile|gnumakefile|justfile|gemfile|rakefile|pipfile|podfile|brewfile|vagrantfile|requirements[\w.-]*|constraints[\w.-]*)$/u;

export type FileType = "code" | "config" | "prose" | "unknown";
/** What a file is by its name: recognised source code, recognised configuration, prose, or a type the classifier does not know. */
export function fileTypeOf(path: string): FileType {
  const name = (normalizedTierPath(path).split("/").at(-1) ?? "");
  if (KNOWN_CONFIG_NAMES.test(name)) return "config";
  const dot = name.lastIndexOf(".");
  const extension = dot <= 0 ? "" : name.slice(dot + 1);
  if (PROSE_EXTENSIONS.has(extension)) return "prose";
  if (CODE_EXTENSIONS.has(extension)) return "code";
  if (CONFIG_EXTENSIONS.has(extension)) return "config";
  return "unknown";
}

// ---- the docs route

/**
 * The docs route (a secret scan and a person's merge, no reviewer): only README*, CHANGELOG* and CONTRIBUTING* at any depth, and everything under a top-level `docs/` or `doc/`, in Markdown, reStructuredText or AsciiDoc. A `.txt`
 * is never on it (a server may read it), and nothing in an instruction, skill, prompt, agent, infrastructure or sensitive area is (the caller adds those checks).
 */
export function isDocsAllowlistPath(path: string): boolean {
  const value = normalizedTierPath(path);
  if (!/\.(md|markdown|rst|adoc)$/u.test(value)) return false;
  const name = value.split("/").at(-1) ?? "";
  return /^(readme|changelog|contributing)(?![a-z0-9])/u.test(name) || /^docs?\//u.test(value);
}
