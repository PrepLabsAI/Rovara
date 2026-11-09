// Port lane L7a: the neutral identity of a repository, the part of every key that says "which repository". Cloud's `plugins/events/repository-key.ts`.
//  - GitHub keeps its old spelling exactly (`owner/name`, lower case), so rows written by Cloud before this exist under the same key;
//  - any other kind is `<kind>:<address>`, the address the install registered, normalised.
// Decision 51: the GitHub branch is the one place the core knows that spelling; the kind is the code host adapter's `kind`.
import type { PluginKind } from "@agentx/contracts";

const GITHUB = "github";
const GITHUB_ADDRESS = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/?$/u;

/** The key part for a repository, or undefined when the address is not one this kind can name. Never throws. */
export function codeHostRepositoryKey(kind: PluginKind, address: string): string | undefined {
  try {
    if (kind === GITHUB) {
      const match = GITHUB_ADDRESS.exec(address);
      return match === null ? undefined : `${match[1]}/${match[2]}`.toLowerCase();
    }
    const url = new URL(address);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "") return undefined;
    const path = url.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
    const key = `${kind}:${url.protocol}//${url.host.toLowerCase()}${path}`;
    return /[#\p{Cc}\p{Cf}]/u.test(key) ? undefined : key;
  } catch {
    return undefined;
  }
}

/** The key part for a repository of a code host, or a refusal (the caller's address was not a repository address of that host). */
export function requireRepositoryKey(kind: PluginKind, address: string): string {
  const key = codeHostRepositoryKey(kind, address);
  if (key === undefined) throw new Error("the repository address is not one this code host can name");
  return key;
}
