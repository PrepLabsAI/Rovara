// The one parser of a GitHub repository address, with the strict checks every credentialed GitHub call relies on (https, github.com only, no port, no credentials in the
// URL, no query, exactly owner/name). It is a pure function, so it sits in the core plug-in kit beside `code-owners-file.ts`: the GitHub plug-in imports it from here, and
// `github-app.ts` re-exports it for the callers that already import it from there.
import { agentXError } from "@rovara-code/contracts";

export function parseGitHubRepository(repositoryUrl: string): { owner: string; name: string } {
  let url: URL;
  try {
    url = new URL(repositoryUrl);
  } catch {
    // An address that is not a URL at all (for example `git@gitlab.com:org/repo`): say "github.com only" when it names another host.
    const named = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@\s/]+@)?([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)[:/]/.exec(repositoryUrl.trim())?.[1];
    throw agentXError("CONFIG_INVALID", named !== undefined && named.toLowerCase() !== "github.com"
      ? "GitHub repository URL is invalid: only github.com repositories are supported"
      : "GitHub repository URL is invalid");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    segments.length !== 2 ||
    segments.some((segment) => segment.includes("%"))
  ) {
    // An empty host (`github.com:org/repo` parses as a scheme) is not another host: no blame.
    throw agentXError("CONFIG_INVALID", url.hostname === "" || url.hostname.toLowerCase() === "github.com"
      ? "credentialed repository must be a canonical GitHub HTTPS URL"
      : "credentialed repository must be a canonical GitHub HTTPS URL: only github.com repositories are supported");
  }
  const [owner, rawName] = segments;
  const name = rawName?.endsWith(".git") ? rawName.slice(0, -4) : rawName;
  if (
    !owner ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) ||
    !name ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(name)
  ) {
    throw agentXError("CONFIG_INVALID", "credentialed repository must be a canonical GitHub HTTPS URL");
  }
  return { owner, name };
}
