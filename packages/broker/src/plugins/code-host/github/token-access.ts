// Port lane L4 (moved here by lane L11, item C3: the sign-in belongs to the code host adapter, not the core): how `rovara up` gets GitHub access with no GitHub App and no Slack: a personal token the owner put in the key file
// (`keys.json`, provider `github`), the `GH_TOKEN` or `GITHUB_TOKEN` variable, or the token the GitHub CLI already holds
// (`gh auth token`). The first one found wins. Nothing here logs or returns the token except as a `SecretValue`.
//
// The adapter that uses it is `token-code-host.ts` (`resolveCredentials` and `checkAccess` on the code host).
import { execFile } from "node:child_process";
import { SecretValue, agentXError, type SecretRef, type SecretStore } from "@agentx/contracts";

export type GithubTokenSource = "key-store" | "environment" | "gh-cli";

export interface GithubAccess {
  token: SecretValue;
  source: GithubTokenSource;
}

/** Runs `gh <args>`; answers the output, or undefined when gh is missing or fails. Injectable for tests. */
export type GhRunner = (args: readonly string[]) => Promise<string | undefined>;

export const runGh: GhRunner = (args) =>
  new Promise((resolve) => {
    execFile("gh", [...args], { timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => resolve(error === null ? stdout : undefined));
  });

const GITHUB_HOST = ["--hostname", "github.com"] as const;

/** Where the owner's stored GitHub token is: the `github` entry of the key file. (Read through the `secrets` socket, owner decision 60.) */
export const GITHUB_TOKEN_REF: SecretRef = { key: "github" };

/**
 * The stored token is read through the `secrets` socket with `GITHUB_TOKEN_REF`, which names the key FILE alone, not the layered model-key store: the
 * environment's `GITHUB_API_KEY` must not win over the file. With `reveal: false` the token is not fetched from `gh` (only whether it is logged in), for a check that only reports.
 */
export async function resolveGithubAccess(input: { companyId: string; secrets: SecretStore; environment: NodeJS.ProcessEnv; gh?: GhRunner; reveal?: boolean }): Promise<GithubAccess | undefined> {
  const stored = await input.secrets.read(input.companyId, GITHUB_TOKEN_REF);
  if (stored !== undefined) return { token: stored, source: "key-store" };
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    const value = input.environment[name]?.trim();
    if (value !== undefined && value !== "") return { token: new SecretValue(value), source: "environment" };
  }
  const gh = input.gh ?? runGh;
  if (input.reveal === false) return (await gh(["auth", "status", ...GITHUB_HOST])) === undefined ? undefined : { token: new SecretValue(""), source: "gh-cli" };
  // The host is named: with GH_HOST set to another server, gh would otherwise answer that server's token.
  const fromCli = (await gh(["auth", "token", ...GITHUB_HOST]))?.trim();
  return fromCli === undefined || fromCli === "" ? undefined : { token: new SecretValue(fromCli), source: "gh-cli" };
}

/**
 * The owner's GitHub token goes only to github.com over https, and only to clone. A repository on any other host (an allowed-but-foreign site, a look-alike name) gets nothing, and a push
 * credential is not issued here at all until the laptop GitHub client (lane L11) scopes one per repository. A stopgap for the 51 gap above, not the final rule.
 */
/**
 * The whole string must be `https://github.com/<owner>/<name>[.git][/]`, checked BEFORE any URL parser sees it. A parser's idea of the host and git's differ for some strings
 * (`https://github.com\@evil.example/x.git` is host github.com to the WHATWG parser and evil.example to git and curl), so nothing but plain characters is let through: no backslash,
 * whitespace, control or non-ASCII character, no `@`, port, query or fragment.
 */
export const GITHUB_REPOSITORY_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/;

export function assertGithubCloneAccess(repositoryUrl: string, access: "clone" | "push"): void {
  assertGithubRepositoryAddress(repositoryUrl);
  if (access !== "clone") throw agentXError("FORBIDDEN", "this install does not give a push credential yet");
}

/** The address rules alone (lane L11): github.com over https, plain characters, agreed by the URL parser. What may be done with the repository is the code host's to decide. */
export function assertGithubRepositoryAddress(repositoryUrl: string): void {
  if (!GITHUB_REPOSITORY_URL.test(repositoryUrl)) throw agentXError("FORBIDDEN", "this install gives the GitHub token only to repositories on github.com");
  // The parser must agree with the pattern (belt and braces).
  let url: URL;
  try {
    url = new URL(repositoryUrl);
  } catch {
    throw agentXError("FORBIDDEN", "the repository address is not valid");
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port !== "" || url.username !== "" || url.password !== "") {
    throw agentXError("FORBIDDEN", "this install gives the GitHub token only to repositories on github.com");
  }
}

/**
 * A repository address the install registers: plain characters only. A backslash, a space or control character, a percent-encoded backslash or a non-ASCII character is where URL
 * parsers part ways about the host, so such an address is refused when the project is registered (not only when a token would be handed out).
 */
export function isPlainRepositoryUrl(repositoryUrl: string): boolean {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  return !/[\\\s\u0000-\u001f\u007f-\uffff]/u.test(repositoryUrl) && !/%5c/iu.test(repositoryUrl);
}
