// Port lane L11: the GitHub code host `rovara up` registers when the owner has a GitHub token (key file, GH_TOKEN, or the GitHub CLI). The adapter is in
// `plugins/code-host/github/token-code-host.ts`; this file only says where the laptop keeps its pieces.
import { join } from "node:path";
import { IMPLICIT_COMPANY_ID, type CodeHost, type ModelKeyStore, type SecretStore } from "@agentx/contracts";
import { createFileModelKeyStore, createLocalSecretStore } from "../ports/index.js";
import { githubTokenCodeHost } from "../plugins/code-host/github/token-code-host.js";
import type { GhRunner } from "../plugins/code-host/github/token-access.js";
import { KEYS_FILE_NAME } from "./state-directory.js";

export interface LocalGithubCodeHostInput {
  stateDirectory: string;
  environment: NodeJS.ProcessEnv;
  /** The company the laptop serves; default the implicit one. */
  companyId?: string | undefined;
  gh?: GhRunner | undefined;
  fetch?: typeof fetch | undefined;
  /** Where the stored token is read (the `secrets` socket; `{ key: "github" }`). Default: Code's own adapter over the key file and the environment. */
  secrets?: SecretStore | undefined;
  /** How to say where the stored token came from (default "the key file"; with a `secrets` plug-in: its name). */
  secretsWords?: string | undefined;
  /** The key file alone (the file store, never the layered model-key store), for the default `secrets`. Default: `<state folder>/keys.json`. */
  keyFile?: ModelKeyStore | undefined;
  /** The addresses of the repositories the company registered; the token is used for these only. Default: none (a doctor run uses no repository). */
  registeredRepositories?: (() => Promise<readonly string[]> | readonly string[]) | undefined;
  /** The owner's choice to give a worker a token that reaches every repository its owner can (config `allowBroadTokenForWorker`). */
  allowBroadTokenForWorker?: boolean | undefined;
}

export function createLocalGithubCodeHost(input: LocalGithubCodeHostInput): CodeHost {
  const keyFilePath = join(input.stateDirectory, KEYS_FILE_NAME);
  return githubTokenCodeHost({
    companyId: input.companyId ?? IMPLICIT_COMPANY_ID,
    secrets: input.secrets ?? createLocalSecretStore({ environment: input.environment, keyFile: input.keyFile ?? createFileModelKeyStore(keyFilePath) }),
    environment: input.environment,
    keyFilePath,
    ...(input.secretsWords === undefined ? {} : { secretsWords: input.secretsWords }),
    registeredRepositories: input.registeredRepositories ?? (() => []),
    allowBroadTokenForWorker: input.allowBroadTokenForWorker === true,
    ...(input.gh === undefined ? {} : { gh: input.gh }),
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });
}

/**
 * The code hosts a laptop can sign in to. `rovara up` registers each one that finds a sign-in under its own `kind`, and `rovara up --check` tests each one; a second host is another
 * entry here, with no change to either (decision 51).
 */
export function createLocalCodeHosts(input: LocalGithubCodeHostInput): CodeHost[] {
  return [createLocalGithubCodeHost(input)];
}
