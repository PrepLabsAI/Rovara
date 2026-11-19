// Rovara Code (Plan 6 Task 20): until Plan 9 closes Linear issues itself, Linear's own GitHub integration closes an issue when a pull request whose title or body says "Fixes <KEY>"
// merges. This says that line for a session bound to a Linear issue, and only that line: the key comes from the session's own Linear binding in the task's org, is checked to be an
// issue key (never free text), and every other Linear-key-shaped token in text a model or a person wrote is broken (`breakLinearKeys`, `sealLinearKeys`), so the pull request names one issue.
import type { SessionBinding } from "@agentx/contracts";

/** A Linear issue key: the team's key (a letter, then letters or digits, ten at most) and the issue's number. */
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9]{0,9}-[1-9][0-9]{0,8}$/u;

/** `text` as an issue key in capitals, or undefined when it is not one (a hostile or malformed value never reaches a description). */
export function normalizeIssueKey(text: string | undefined): string | undefined {
  return text !== undefined && ISSUE_KEY.test(text) ? text.toUpperCase() : undefined;
}

/** The URL of a Linear link, or undefined unless it is https on `linear.app` itself with no user name, password or port. */
function linearUrl(link: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return undefined;
  }
  return url.protocol === "https:" && url.hostname === "linear.app" && url.username === "" && url.password === "" && url.port === "" ? url : undefined;
}

/** The issue key in a Linear URL: `/<workspace>/issue/<KEY>[/<slug>]`, or the short `/issue/<KEY>`. Anything after the key is dropped. */
function keyOfUrl(url: URL): string | undefined {
  const parts = url.pathname.split("/").filter((part) => part !== "");
  const inWorkspace = parts[1] === "issue" ? normalizeIssueKey(parts[2]) : undefined;
  return inWorkspace ?? (parts[0] === "issue" ? normalizeIssueKey(parts[1]) : undefined);
}

/** The workspace url key in a Linear issue link (`https://linear.app/acme/issue/ENG-142/...` is `acme`); undefined for the short form `/issue/KEY`, a link that is not Linear's, or a name that is not a url key. */
export function linearWorkspaceOfLink(link: string): string | undefined {
  const url = linearUrl(link);
  if (url === undefined) return undefined;
  const parts = url.pathname.split("/").filter((part) => part !== "");
  const name = parts[1] === "issue" && normalizeIssueKey(parts[2]) !== undefined ? parts[0]?.toLowerCase() : undefined;
  return name !== undefined && /^[a-z0-9][a-z0-9-]{0,62}$/u.test(name) ? name : undefined;
}

/** The workspace url key a Linear binding names, or undefined for a binding that has none (an older one) or that is not a Linear issue's. */
export const linearWorkspaceOfBinding = (binding: SessionBinding): string | undefined => (binding.kind === "linear_issue" ? binding.workspace : undefined);

/** The link to show for a Linear binding: with its workspace when it names one, else the link it was stored with. A link that names the wrong workspace is never built from a guess. */
export function linearLinkOfBinding(binding: SessionBinding): string {
  if (binding.kind !== "linear_issue") return "";
  const key = linearIssueKeyOf(binding);
  return binding.workspace !== undefined && key !== undefined ? `https://linear.app/${binding.workspace}/issue/${key}` : binding.url;
}

/**
 * What a person typed to name a Linear issue (Plan 6 Task 20's link command): the issue key (`ENG-142`, any case) or the issue's Linear link. The result is the binding's issue id (the key in
 * capitals) and Linear's short link `https://linear.app/issue/<KEY>`. A typed workspace is not part of this result: `linearWorkspaceOfLink` reads it, and the binding keeps it only to NARROW what is believed
 * (comments from, and answers written to, that workspace); it never widens anything. Anything else is undefined.
 */
export function parseLinearIssue(text: string): { issueId: string; url: string } | undefined {
  const typed = text.trim();
  if (typed.length === 0 || typed.length > 2048) return undefined;
  const url = linearUrl(typed);
  const key = normalizeIssueKey(typed) ?? (url === undefined ? undefined : keyOfUrl(url));
  return key === undefined ? undefined : { issueId: key, url: `https://linear.app/issue/${key}` };
}

/**
 * The key of the Linear issue a binding follows. The issue id is the key where the binder used it; otherwise the key is read from the issue's Linear link. An id and a link that name
 * different issues are no key at all, a link that is not Linear's makes the binding unusable, and a Slack thread has none.
 */
export function linearIssueKeyOf(binding: SessionBinding): string | undefined {
  // A ticket a task started from, in the tracker that registered as `linear`, is a Linear issue like any other: the same checks apply to its id and link.
  const id = binding.kind === "linear_issue" ? binding.issueId : binding.kind === "tracker_item" && binding.system === "linear" ? binding.id : undefined;
  if (binding.kind === "slack_thread" || id === undefined) return undefined;
  // A link that is not Linear's makes the binding unusable, whatever its id says.
  const url = linearUrl(binding.url);
  if (url === undefined) return undefined;
  const fromId = normalizeIssueKey(id);
  const fromLink = keyOfUrl(url);
  if (fromId !== undefined && fromLink !== undefined && fromId !== fromLink) return undefined;
  return fromId ?? fromLink;
}

/** The line Linear's GitHub integration reads. */
export const linearCloseLine = (key: string): string => `Fixes ${key}`;

/**
 * The key of the Linear issue a task's session follows, from the session's bindings (read by the caller from the session store, in the task's own company; a binding that cannot be read is the
 * caller's to log and read as none: the pull request then opens without the line, and the next rewrite of its description adds it). Undefined without a Linear binding.
 * 51 gap: the line that closes an issue on merge is Linear's GitHub integration's; a second tracker would need its own closing line behind the Tracker port.
 */
export function linearIssueKeyOfBindings(bindings: readonly SessionBinding[]): string | undefined {
  return bindings.map(linearIssueKeyOf).find((key) => key !== undefined);
}

const isAlphanumeric = (code: number): boolean => (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const isLetter = (code: number): boolean => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const JOINER = "\u200D";

/**
 * Text in which no Linear issue key can be read (used for a pull request's title, where a bare key links and may move the issue, and which holds nothing anyone copies): after the hyphen of every key-shaped token (a run of letters and digits with a letter in it, a hyphen, a digit) an invisible joiner is put,
 * whatever comes before it (a closing word, markdown, a bracket, a quote, nothing) or after it. Nobody knows what Linear's reader strips or accepts, so the key is broken, never the words
 * around it. The text reads the same. Dates and version numbers (`2026-10-26`, `12-34`) have no letter in the run and stay as they are. One pass, linear in the text.
 */
export function breakLinearKeys(text: string): string {
  let out = "";
  let copied = 0;
  for (let at = text.indexOf("-"); at !== -1; at = text.indexOf("-", at + 1)) {
    const next = text.charCodeAt(at + 1);
    if (!(next >= 48 && next <= 57)) continue;
    let start = at - 1;
    let letter = false;
    while (start >= 0 && isAlphanumeric(text.charCodeAt(start))) {
      if (isLetter(text.charCodeAt(start))) letter = true;
      start -= 1;
    }
    if (!letter) continue;
    out += text.slice(copied, at + 1) + JOINER;
    copied = at + 1;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

// Linear acts on a key only after one of its magic words (docs: "Linking pull requests" and the GitHub/GitLab integration pages): the closing words close, fix, resolve, complete, implement (each with
// -s, -d or -ing) and the linking words ref(s), references, part of, contributes to, towards, updates, related to, relates to. A key by itself in a description does nothing; a key in a title or branch name links.
const MAGIC_WORDS = "close[sd]?|closing|fix(?:es|ed|ing)?|resolve[sd]?|resolving|complete[sd]?|completing|implement(?:s|ed|ing)?|refs?|references|towards?|updates|part\\s+of|contributes?\\s+to|relates?\\s+to|related\\s+to";
/** Up to twelve characters of anything but letters and digits (spaces, punctuation, markdown, line breaks), or a character reference, between the word and the key. */
const MAGIC_GAP = "(?:[^A-Za-z0-9]|&[a-z]+;|&#x?[0-9a-f]+;){0,12}";
/** The start of a key: letters and digits with a letter first, then a hyphen (backslash-escaped, as the feedback section writes it) and a digit. */
const KEY_START = "[A-Za-z][A-Za-z0-9]*\\\\?-\\d";
const MAGIC_BEFORE_KEY = new RegExp(`(?<![A-Za-z0-9])(?:${MAGIC_WORDS})(?![A-Za-z0-9])(?=${MAGIC_GAP}${KEY_START})`, "giu");

/**
 * Text in which Linear can read no magic word before a key: the word (whole word, any case, with any markdown or punctuation around it) that has a key within a few characters after it gets an
 * invisible joiner after its first letter, so it reads the same and is not the word. The key itself, and every other word, number, path, code span and fence, are left byte for byte
 * (`UTF-8`, `SHA-256`, `node-22`, `db/V1-2__init.sql` are untouched). The same word with no key after it (`Fixes the null check`) is untouched too. Linear time.
 */
export function neutralizeLinearWords(text: string): string {
  return text.replace(MAGIC_BEFORE_KEY, (word) => `${word.slice(0, 1)}${JOINER}${word.slice(1)}`);
}

/** The lines with every magic word before a key neutralized but Rovara's own `Fixes <KEY>` line (exactly that line, for exactly the key given), which is left whole. */
export function sealLinearText(lines: readonly string[], ownKey: string | undefined): string[] {
  const own = ownKey === undefined ? undefined : linearCloseLine(ownKey);
  return lines.map((line) => (own !== undefined && line === own ? line : neutralizeLinearWords(line)));
}
