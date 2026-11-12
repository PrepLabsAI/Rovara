// Lessons for local coding tools (decision 46b): which repository a tool is in, from the git remote it sends. The tool's claim is only a name: the broker matches it against the project's REGISTERED repository
// addresses (the `byRemote` read of the project-repository port), so an address that is not one of the project's is "no such repository", the same as one that is another company's.
// `normalizeRemote` turns every spelling of the same address into one comparable `host/path` text: https, http, ssh:// and scp-style (git@host:owner/name) addresses, with or without ".git", a trailing slash, a port or a
// user name. Pure; no I/O. An address it cannot read into a host and at least two path parts is undefined (never "matches everything").
const MAX_REMOTE = 400;
const HOST = /^[a-z0-9][a-z0-9.-]{0,252}$/u;
const PART = /^[a-z0-9._~-]{1,100}$/u;

export function normalizeRemote(raw: string): string | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_REMOTE || /[\p{Cc}\p{Cf}\s]/u.test(raw)) return undefined;
  let host: string;
  let path: string;
  const scp = /^(?:[^@/:]+@)?([^:/@]+):(?!\/\/)(.+)$/u.exec(raw);
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(raw)) {
    let url: URL;
    try { url = new URL(raw); } catch { return undefined; }
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return undefined;
    host = url.hostname;
    path = decodeURIComponent(url.pathname);
  } else if (scp !== null) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    const slash = raw.indexOf("/");
    if (slash <= 0) return undefined;
    host = raw.slice(0, slash);
    path = raw.slice(slash + 1);
  }
  host = host.toLowerCase().replace(/\.$/u, "");
  if (!HOST.test(host) || !host.includes(".") && host !== "localhost") return undefined;
  const parts = path.replace(/^\/+|\/+$/gu, "").replace(/\.git$/iu, "").toLowerCase().split("/");
  if (parts.length < 2 || !parts.every((part) => PART.test(part) && part !== "." && part !== "..")) return undefined;
  return `${host}/${parts.join("/")}`;
}
