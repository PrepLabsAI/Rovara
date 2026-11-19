// P6: the neutral identity of a repository, the part of every key that says "which repository" for a code host event.
//
// Linked-pull-request rows, the head index and the merge-commit index all used GitHub's `owner/name` (lower-cased). The key has a neutral spelling, with the host's kind:
//  - GitHub keeps its old spelling exactly (`owner/name`, lower case), so every row written before this exists under the same key and is read as before (no data migration);
//  - any other kind is `<kind>:<address>`, the address the install registered, normalised (scheme and host in lower case, no query, fragment, trailing slash or `.git`).
// A key is never taken from an event's body: the caller builds it from the address the project registered, or from the neutral event's repository address, and compares.
import type { PluginKind } from "@agentx/contracts";

/** The kind GitHub's repositories are filed under. */
const GITHUB = "github";
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/u;

/** `owner/name` (lower case) of a canonical github.com address: https, host exactly github.com, no port, credentials, query or fragment, two path segments with no escapes. Reads the address itself, so the core does not depend on the GitHub adapter. */
function githubOwnerAndName(address: string): string | undefined {
  const url = new URL(address);
  const segments = url.pathname.split("/").filter(Boolean);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.port !== "" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== ""
    || segments.length !== 2 || segments.some((segment) => segment.includes("%"))) return undefined;
  const owner = segments[0]!;
  const name = segments[1]!.endsWith(".git") ? segments[1]!.slice(0, -4) : segments[1]!;
  return OWNER.test(owner) && NAME.test(name) && name !== "." && name !== ".." ? `${owner}/${name}`.toLowerCase() : undefined;
}

/** The key part for a repository, or undefined when the address is not one this kind can name. Never throws. */
export function codeHostRepositoryKey(kind: PluginKind, address: string): string | undefined {
  try {
    if (kind === GITHUB) return githubOwnerAndName(address);
    const url = new URL(address);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "") return undefined;
    const path = url.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
    const key = `${kind}:${url.protocol}//${url.host.toLowerCase()}${path}`;
    return /[#\p{Cc}\p{Cf}]/u.test(key) ? undefined : key;
  } catch {
    return undefined;
  }
}
