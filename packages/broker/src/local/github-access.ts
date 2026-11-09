// Port lane L4: how `rovara up` gets GitHub access with no GitHub App and no Slack: a personal token the owner put in the key file
// (`keys.json`, provider `github`), the `GH_TOKEN` or `GITHUB_TOKEN` variable, or the token the GitHub CLI already holds
// (`gh auth token`). The first one found wins. Nothing here logs or returns the token except as a `SecretValue`.
//
// 51 gap: this is GitHub-specific and lives in the local runtime; it belongs behind the `code-host` plug-in point (a credential source
// and an access check on the adapter) once that port exists (lane L1).
import { execFile } from "node:child_process";
import { SecretValue, agentXError, type ModelKeyStore } from "@agentx/contracts";

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

/**
 * `keyFile` must be the key FILE alone, not the layered store: the environment's `GITHUB_API_KEY` would otherwise win over the
 * file. With `reveal: false` the token is not fetched from `gh` (only whether it is logged in), for a check that only reports.
 */
export async function resolveGithubAccess(input: { companyId: string; keyFile: ModelKeyStore; environment: NodeJS.ProcessEnv; gh?: GhRunner; reveal?: boolean }): Promise<GithubAccess | undefined> {
  const stored = await input.keyFile.get(input.companyId, "github");
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
export function assertGithubCloneAccess(repositoryUrl: string, access: "clone" | "push"): void {
  let url: URL;
  try {
    url = new URL(repositoryUrl);
  } catch {
    throw agentXError("FORBIDDEN", "the repository address is not valid");
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port !== "" || url.username !== "" || url.password !== "") {
    throw agentXError("FORBIDDEN", "this install gives the GitHub token only to repositories on github.com");
  }
  if (access !== "clone") throw agentXError("FORBIDDEN", "this install does not give a push credential yet");
}
