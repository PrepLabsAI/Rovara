// The paths that make a change sensitive. A leaf copied from the hosted product's pull request risk module (path patterns only, no state); the merge lane may move it.
// Each pattern is tested against the whole path, lower-cased and written with `/`, so a directory name must be a whole path segment (`src/author.ts` and `src/diamond.ts` are not `auth` or `iam`).

/** The paths that make a change high risk: migrations, auth, security, credentials, payments, secrets, iam, infra, terraform, cdk, `.github/workflows`, `*.sql`, `*.tf` and `Dockerfile`. */
export const RISK_SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)(migrations|auth|authn|authz|security|oauth|saml|sso|jwt|crypto|permissions|credentials|payments|billing|secrets|iam|infra|terraform|cdk)(\/|$)/,
  /(^|\/)\.github\/workflows(\/|$)/,
  // What decides what is checked before a merge, on any code host: other hosts' pipelines too.
  /(^|\/)(\.gitlab-ci\.ya?ml|\.gitlab\/|bitbucket-pipelines\.ya?ml|\.circleci\/|azure-pipelines\.ya?ml|jenkinsfile|\.buildkite\/)/,
  // Who must approve and how a branch is protected: a change to them changes the rules every later merge follows.
  /(^|\/)codeowners$/,
  /(^|\/)\.github\/(settings\.ya?ml|rulesets?(\/|$)|branch[-_]protection[^/]*)$/,
  /\.(sql|tf)$/,
  /(^|\/)dockerfile$/,
];

function normalized(path: string): string {
  return path.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "").toLowerCase();
}

/** The words that make a file sensitive when its name is one, or is made of one joined to others by `-`, `_` or `.` (`jwt.ts`, `user-auth.ts`, `oauth_client.py`); `author.ts` and `secretsanta.ts` are not. */
const SENSITIVE_NAME_WORDS: ReadonlySet<string> = new Set(["auth", "authn", "authz", "security", "oauth", "saml", "sso", "jwt", "crypto", "permissions", "credentials", "secrets", "iam"]);
/** Documents about a topic are not code for it. */
const DOCUMENT_EXTENSIONS = /\.(md|mdx|markdown|txt|rst|adoc)$/u;

/** Whether a path has a segment (or the workflows folder, or a file name) that makes it sensitive. */
export function isSensitivePath(path: string): boolean {
  const value = normalized(path);
  if (RISK_SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(value))) return true;
  const name = value.split("/").at(-1) ?? "";
  return !DOCUMENT_EXTENSIONS.test(name) && name.split(/[-_.]/u).some((word) => SENSITIVE_NAME_WORDS.has(word));
}
