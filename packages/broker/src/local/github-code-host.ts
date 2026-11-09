// Port lane L11: the GitHub code host `rovara up` registers when the owner has a GitHub token (key file, GH_TOKEN, or the GitHub CLI). The adapter is in
// `plugins/code-host/github/token-code-host.ts`; this file only says where the laptop keeps its pieces.
import { join } from "node:path";
import { IMPLICIT_COMPANY_ID, type CodeHost, type ModelKeyStore } from "@agentx/contracts";
import { createFileModelKeyStore } from "../ports/index.js";
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
  /** The key file alone (the file store, never the layered model-key store). Default: `<state folder>/keys.json`. */
  keyFile?: ModelKeyStore | undefined;
}

export function createLocalGithubCodeHost(input: LocalGithubCodeHostInput): CodeHost {
  const keyFilePath = join(input.stateDirectory, KEYS_FILE_NAME);
  return githubTokenCodeHost({
    companyId: input.companyId ?? IMPLICIT_COMPANY_ID,
    keyFile: input.keyFile ?? createFileModelKeyStore(keyFilePath),
    environment: input.environment,
    keyFilePath,
    ...(input.gh === undefined ? {} : { gh: input.gh }),
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });
}
