// Port lane L11: the GitHub code host for a laptop, signed in with the owner's own token. It is `githubCodeHost` (the same adapter Cloud's App client sits under) over `githubTokenClient`
// (`token-client.ts`), plus the two things a laptop needs from a code host and a cloud install does not (BOTH-OWNERS-INTERFACE-ITEMS C3):
//   - `resolveCredentials`: "find my sign-in": the key file, then `GH_TOKEN` / `GITHUB_TOKEN`, then the GitHub CLI (`token-access.ts`). It makes no network call and returns no secret.
//   - `checkAccess`: "test my connection": one `GET /user` with the token, in plain words.
// The token is read when it is used (kept for 30 seconds), so a new `gh auth login` or an edited key file is picked up without a restart.
import { agentXError, type CodeHost, type CodeHostAccessCheck, type CodeHostSignInResult, type SecretStore, type SecretValue } from "@agentx/contracts";
import { LocalSecretError } from "../../../ports/secret-error.js";
import { githubCodeHost, GITHUB_CODE_HOST_CAPABILITIES } from "./index.js";
import { GITHUB_TOKEN_REF, resolveGithubAccess, type GhRunner, type GithubAccess, type GithubTokenSource } from "./token-access.js";
import { boundToCompany, describeTokenAccount, githubTokenClient, githubTokenReach } from "./token-client.js";

/** The credential reference of the laptop's one GitHub sign-in. */
export const LOCAL_GITHUB_CREDENTIAL_REF = "github";
const TOKEN_REUSE_MS = 30_000;

export interface GitHubTokenCodeHostOptions {
  /** The one company this laptop serves (an organization id): every call is held to it. */
  companyId: string;
  /** Where the stored token is read (the `secrets` socket; see `resolveGithubAccess`). */
  secrets: SecretStore;
  /** How to say where the stored token came from, after "from" (default "the key file"; with a `secrets` plug-in: its name). */
  secretsWords?: string;
  environment: NodeJS.ProcessEnv;
  /** Runs the GitHub CLI; injectable for tests. */
  gh?: GhRunner;
  fetch?: typeof fetch;
  now?: () => number;
  /** The path of the key file, for the words that tell the owner what to fix. */
  keyFilePath?: string;
  /** The repositories the company registered (its projects'): the only ones the token is used for. Read on every use. */
  registeredRepositories(): Promise<readonly string[]> | readonly string[];
  /** The owner's explicit choice to give a worker a token that reaches every repository its owner can. Default false. */
  allowBroadTokenForWorker?: boolean;
}

const FINE_GRAINED_ADVICE = "Make a fine-grained personal access token limited to the repositories of your Rovara projects (GitHub, Settings, Developer settings), with Contents and Pull requests set to read and write, and put it in GH_TOKEN or keys.json.";

const SOURCE_WORDS: Record<GithubTokenSource, string> = { "gh-cli": "the GitHub CLI", environment: "the environment", "key-store": "the key file" };

/** A `secrets` adapter other than Code's failed to read the token. Its own text is never shown (it may quote a name or content); this sentence names the kind of source asked. */
class ForeignSecretsError extends Error {
  constructor() {
    super(`the secrets adapter could not read the GitHub token (source kind: ${Object.keys(GITHUB_TOKEN_REF)[0]})`);
    this.name = "ForeignSecretsError";
  }
}

export function githubTokenCodeHost(options: GitHubTokenCodeHostOptions): CodeHost {
  const now = options.now ?? Date.now;
  const fetchImplementation = options.fetch ?? fetch;
  const keyFileWords = options.keyFilePath ?? "keys.json";
  const sourceWords = (source: GithubTokenSource): string => (source === "key-store" && options.secretsWords !== undefined ? options.secretsWords : SOURCE_WORDS[source]);
  const resolve = async (reveal: boolean): Promise<GithubAccess | undefined> => {
    try {
      return await resolveGithubAccess({
        companyId: options.companyId, secrets: options.secrets, environment: options.environment, reveal, ...(options.gh === undefined ? {} : { gh: options.gh }),
      });
    } catch (error) {
      // Code's own readers throw fixed sentences. Anything else comes from a plug-in and is replaced.
      throw error instanceof LocalSecretError ? error : new ForeignSecretsError();
    }
  };

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
    registeredRepositories: () => options.registeredRepositories(), allowBroadTokenForWorker: options.allowBroadTokenForWorker === true,
  });
  const base = githubCodeHost(provider, { credentialRef: LOCAL_GITHUB_CREDENTIAL_REF, now });

  const noAccess = (): CodeHostSignInResult => ({
    found: false,
    summary: "No GitHub access was found.",
    fix: 'Run `gh auth login` (https://cli.github.com), or put a personal access token in GH_TOKEN, or in keys.json as {"github": "<token>"}.',
  });
  const unreadable = (error: unknown): { summary: string; fix: string } => error instanceof LocalSecretError
    // Code's key file messages say what is wrong with it and never quote it.
    ? { summary: error.message, fix: `Fix the file's permissions with \`chmod 600 ${keyFileWords}\`.` }
    : { summary: error instanceof ForeignSecretsError ? error.message : "the GitHub token could not be read", fix: `Check the secrets plug-in in your config: it must answer ${JSON.stringify(GITHUB_TOKEN_REF)}, or set GH_TOKEN instead.` };

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
      const source = sourceWords(access.source);
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
      const where = sourceWords(access.source);
      try {
        const account = await describeTokenAccount(access.token.reveal(), fetchImplementation);
        if (account.status === "rejected") {
          return { status: "fail", summary: `GitHub rejected the token from ${where}.`, fix: access.source === "gh-cli" ? "Run `gh auth login` again, or better, make a fine-grained token (see below) and set it in GH_TOKEN. " + FINE_GRAINED_ADVICE : "Make a new token and replace the old one. " + FINE_GRAINED_ADVICE };
        }
        if (account.status === "unavailable") return { status: "warn", summary: `GitHub answered HTTP ${account.httpStatus ?? 0} when the token was checked.`, fix: "Try again in a minute." };
        const who = account.login === undefined ? "" : ` as ${account.login}`;
        const named = account.login === undefined ? {} : { account: account.login };
        const broad = githubTokenReach(access.token.reveal()) === "broad";
        if (broad) {
          // A classic token or the GitHub CLI's reaches every repository its owner can. Scopes only say how far: `admin:*`, `delete_repo`, `workflow`, `gist` and `read:org` reach well past one project.
          const wide = (account.scopes ?? []).filter((scope) => /^(?:admin:|delete_repo$|workflow$|gist$|read:org$|write:org$|user$|repo$)/u.test(scope));
          const scopes = wide.length === 0 ? "" : ` (scopes: ${wide.join(", ")})`;
          const cannotOpen = account.scopes !== undefined && !account.scopes.includes("repo") && !account.scopes.includes("public_repo") ? " It also has no `repo` scope, so it cannot open pull requests." : "";
          const worker = options.allowBroadTokenForWorker === true ? "You have allowed it to be given to a task's worker." : "Rovara will not give it to a task's worker unless you set allowBroadTokenForWorker to true in the config.";
          return { status: "warn", summary: `GitHub access works${who} (token from ${where}), but this token can reach every repository you can${scopes}.${cannotOpen} ${worker}`, fix: FINE_GRAINED_ADVICE, ...named };
        }
        return { status: "ok", summary: `GitHub access works${who} (token from ${where}).`, ...named };
      } catch {
        return { status: "warn", summary: "GitHub could not be reached to check the token.", fix: "Check your internet connection. Rovara needs GitHub only when a task starts." };
      }
    },
  };
}
