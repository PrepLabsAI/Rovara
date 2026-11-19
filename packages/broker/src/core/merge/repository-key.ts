// Port lane L7a: the repository key is lane L7b's (`proof/revert/repository-key.ts`), one implementation for the revert detector and the merge core. This file adds the refusing form.
import type { PluginKind } from "@agentx/contracts";
import { codeHostRepositoryKey } from "../proof/revert/repository-key.js";

export { codeHostRepositoryKey };

/** The key part for a repository of a code host, or a refusal (the caller's address was not a repository address of that host). */
export function requireRepositoryKey(kind: PluginKind, address: string): string {
  const key = codeHostRepositoryKey(kind, address);
  if (key === undefined) throw new Error("the repository address is not one this code host can name");
  return key;
}
