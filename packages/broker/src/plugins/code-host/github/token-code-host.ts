// Port lane L11: the GitHub code host for a laptop, signed in with the owner's own token. It is `githubCodeHost` (the same adapter Cloud's App client sits under) over `githubTokenClient`
// (`token-client.ts`), plus the two things a laptop needs from a code host and a cloud install does not (BOTH-OWNERS-INTERFACE-ITEMS C3):
//   - `resolveCredentials`: "find my sign-in": the key file, then `GH_TOKEN` / `GITHUB_TOKEN`, then the GitHub CLI (`token-access.ts`). It makes no network call and returns no secret.
//   - `checkAccess`: "test my connection": one `GET /user` with the token, in plain words.
// The token is read when it is used (kept for 30 seconds), so a new `gh auth login` or an edited key file is picked up without a restart.
import { agentXError, type CodeHost, type CodeHostAccessCheck, type CodeHostSignInResult, type ModelKeyStore, type SecretValue } from "@agentx/contracts";
import { githubCodeHost, GITHUB_CODE_HOST_CAPABILITIES } from "./index.js";
import { resolveGithubAccess, type GhRunner, type GithubAccess, type GithubTokenSource } from "./token-access.js";
import { boundToCompany, describeTokenAccount, githubTokenClient } from "./token-client.js";

/** The credential reference of the laptop's one GitHub sign-in. */
export const LOCAL_GITHUB_CREDENTIAL_REF = "github";
const TOKEN_REUSE_MS = 30_000;

export interface GitHubTokenCodeHostOptions {
  /** The one company this laptop serves (an organization id): every call is held to it. */
  companyId: string;
  /** The key file ALONE, not the layered model-key store (see `resolveGithubAccess`). */
  keyFile: ModelKeyStore;
  environment: NodeJS.ProcessEnv;
  /** Runs the GitHub CLI; injectable for tests. */
  gh?: GhRunner;
  fetch?: typeof fetch;
  now?: () => number;
  /** The path of the key file, for the words that tell the owner what to fix. */
  keyFilePath?: string;
}

const SOURCE_WORDS: Record<GithubTokenSource, string> = { "gh-cli": "the GitHub CLI", environment: "the environment", "key-store": "the key file" };

export function githubTokenCodeHost(options: GitHubTokenCodeHostOptions): CodeHost {
  const now = options.now ?? Date.now;
  const fetchImplementation = options.fetch ?? fetch;
  const keyFileWords = options.keyFilePath ?? "keys.json";
  const resolve = (reveal: boolean): Promise<GithubAccess | undefined> => resolveGithubAccess({
    companyId: options.companyId, keyFile: options.keyFile, environment: options.environment, reveal, ...(options.gh === undefined ? {} : { gh: options.gh }),
  });

  let cached: { at: number; token: SecretValue } | undefined;
  const getToken = async (): Promise<SecretValue> => {
    if (cached !== undefined && now() - cached.at < TOKEN_REUSE_MS) return cached.token;
    const access = await resolve(true);
    if (access === undefined) throw agentXError("CONFIG_INVALID", "no GitHub sign-in was found; run `gh auth login`, or set GH_TOKEN");
    cached = { at: now(), token: access.token };
    return access.token;
  };

  const provider = githubTokenClient({
    credentialRef: LOCAL_GITHUB_CREDENTIAL_REF, getToken, requireBound: boundToCompany(options.companyId), fetchImplementation, now,
  });
  const base = githubCodeHost(provider, { credentialRef: LOCAL_GITHUB_CREDENTIAL_REF, now });

  const noAccess = (): CodeHostSignInResult => ({
    found: false,
    summary: "No GitHub access was found.",
    fix: 'Run `gh auth login` (https://cli.github.com), or put a personal access token in GH_TOKEN, or in keys.json as {"github": "<token>"}.',
  });
  const unreadable = (error: unknown): { summary: string; fix: string } => ({
    // The key file's messages say what is wrong with it and never quote it.
    summary: error instanceof Error && error.message !== "" ? error.message : "the key file could not be read",
    fix: `Fix the file's permissions with \`chmod 600 ${keyFileWords}\`.`,
  });

  return {
    ...base,
    // A laptop has no public address for GitHub to call, so nothing arrives by webhook; the install asks.
    capabilities: { ...GITHUB_CODE_HOST_CAPABILITIES, webhooks: false },
    events: { mode: "poll" },

    async resolveCredentials(): Promise<CodeHostSignInResult> {
      let access: GithubAccess | undefined;
      try {
        access = await resolve(false);
      } catch (error) {
        return { found: false, ...unreadable(error) };
      }
      if (access === undefined) return noAccess();
      const source = SOURCE_WORDS[access.source];
      return { found: true, source, summary: `A GitHub token is available from ${source}.` };
    },

    async checkAccess(): Promise<CodeHostAccessCheck> {
      let access: GithubAccess | undefined;
      try {
        access = await resolve(true);
      } catch (error) {
        return { status: "fail", ...unreadable(error) };
      }
      if (access === undefined) {
        const none = noAccess();
        return { status: "fail", summary: none.summary, fix: none.fix! };
      }
      const where = SOURCE_WORDS[access.source];
      try {
        const account = await describeTokenAccount(access.token.reveal(), fetchImplementation);
        if (account.status === "rejected") {
          return { status: "fail", summary: `GitHub rejected the token from ${where}.`, fix: access.source === "gh-cli" ? "Run `gh auth login` again." : "Make a new personal access token with the `repo` scope and replace the old one." };
        }
        if (account.status === "unavailable") return { status: "warn", summary: `GitHub answered HTTP ${account.httpStatus ?? 0} when the token was checked.`, fix: "Try again in a minute." };
        const who = account.login === undefined ? "" : ` as ${account.login}`;
        // A classic token lists its scopes; one with neither `repo` nor `public_repo` cannot open a pull request. A fine-grained token lists none, and GitHub is asked at the first task instead.
        if (account.scopes !== undefined && !account.scopes.includes("repo") && !account.scopes.includes("public_repo")) {
          return { status: "warn", summary: `GitHub access works${who} (token from ${where}), but the token has no \`repo\` scope.`, fix: "Make a new personal access token with the `repo` scope (or a fine-grained token with Contents and Pull requests write access to your repositories).", ...(account.login === undefined ? {} : { account: account.login }) };
        }
        return { status: "ok", summary: `GitHub access works${who} (token from ${where}).`, ...(account.login === undefined ? {} : { account: account.login }) };
      } catch {
        return { status: "warn", summary: "GitHub could not be reached to check the token.", fix: "Check your internet connection. Rovara needs GitHub only when a task starts." };
      }
    },
  };
}
