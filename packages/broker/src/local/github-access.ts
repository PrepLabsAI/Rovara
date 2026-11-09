// Port lane L4: how `rovara up` gets GitHub access with no GitHub App and no Slack: a personal token the owner put in the key store
// (`keys.json`, provider `github`), the `GH_TOKEN` or `GITHUB_TOKEN` variable, or the token the GitHub CLI already holds
// (`gh auth token`). The first one found wins. Nothing here logs or returns the token except as a `SecretValue`.
import { execFile } from "node:child_process";
import { SecretValue, type ModelKeyStore } from "@agentx/contracts";

export type GithubTokenSource = "key-store" | "environment" | "gh-cli";

export interface GithubAccess {
  token: SecretValue;
  source: GithubTokenSource;
}

/** Runs `gh <args>`; answers undefined when gh is missing or fails. Injectable for tests. */
export type GhRunner = (args: readonly string[]) => Promise<string | undefined>;

export const runGh: GhRunner = (args) =>
  new Promise((resolve) => {
    execFile("gh", [...args], { timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => resolve(error === null ? stdout : undefined));
  });

export async function resolveGithubAccess(input: { companyId: string; keys: ModelKeyStore; environment: NodeJS.ProcessEnv; gh?: GhRunner }): Promise<GithubAccess | undefined> {
  const stored = await input.keys.get(input.companyId, "github");
  if (stored !== undefined) return { token: stored, source: "key-store" };
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    const value = input.environment[name]?.trim();
    if (value !== undefined && value !== "") return { token: new SecretValue(value), source: "environment" };
  }
  const fromCli = (await (input.gh ?? runGh)(["auth", "token"]))?.trim();
  return fromCli === undefined || fromCli === "" ? undefined : { token: new SecretValue(fromCli), source: "gh-cli" };
}
