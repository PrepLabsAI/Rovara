// DEC 254p (a): how a GitHub person is named and pictured in admin tools, the way a Slack person's name is shown.
// Everything GitHub (or a stored record) says about a person is untrusted text: it is cut, stripped of markup and checked here, once, and every
// display site calls these two functions. A name is the person's GitHub name, or their login when they set none. The picture is never taken from
// GitHub's answer: it is built from the numeric id GitHub signed the person in with, on GitHub's one avatar host, so it can name no other address.
import { cleanDisplayName, emailSafeName, isReservedDisplayName } from "@agentx/contracts";

export const GITHUB_ISSUER_URL = "https://github.com";
export const GITHUB_AVATAR_BASE = "https://avatars.githubusercontent.com/u/";
/** GitHub's numeric user id as the sign-in stores it (providers.ts checks the same bounds). */
const GITHUB_SUBJECT = /^[1-9][0-9]{0,15}$/u;
/** Longest text read before cleaning: a hostile megabyte is cut before any scan; the name itself ends at 80 code points. */
const READ_MAX = 1_000;
/** HTML and Markdown syntax characters. A name has no markup: these become spaces, so a tag, a link or emphasis cannot be written with them. */
const MARKUP = /[<>&`[\]*_~|\\]/gu;

/** A person's GitHub name as others may see it: plain text of at most 80 code points, or `fallback` when nothing usable is left (or the name looks like a placeholder). */
export function githubDisplayName(name: unknown, fallback: string): string {
  if (typeof name !== "string") return fallback;
  let cut = name.slice(0, READ_MAX);
  // Never leave half of a surrogate pair at the cut.
  if (/[\uD800-\uDBFF]$/u.test(cut)) cut = cut.slice(0, -1);
  // Compatibility forms first (a fullwidth bracket or star is markup once folded), then again after the email step, which may fold a name that held an address: the result is always markup-free.
  const stripped = emailSafeName(cut.normalize("NFKC").replace(MARKUP, " "));
  const clean = stripped === undefined ? undefined : cleanDisplayName(stripped.normalize("NFKC").replace(MARKUP, " "));
  return clean === undefined || isReservedDisplayName(clean) ? fallback : clean;
}

/** The stored subject is GitHub's numeric id only; anything else gives no picture. */
export function githubAvatarUrl(issuer: unknown, subject: unknown): string | undefined {
  if (issuer !== GITHUB_ISSUER_URL || typeof subject !== "string" || !GITHUB_SUBJECT.test(subject) || !Number.isSafeInteger(Number(subject))) return undefined;
  return `${GITHUB_AVATAR_BASE}${subject}?s=96`;
}

type PersonLike = { provider?: unknown; issuer?: unknown; subject?: unknown; displayName?: unknown };

/** A stored person's name for display. A GitHub person's goes through `githubDisplayName`; every other person's is returned exactly as stored. */
export function profileDisplayName(record: PersonLike): string | undefined {
  if (typeof record.displayName !== "string") return undefined;
  if (record.provider !== "github") return record.displayName;
  return githubDisplayName(record.displayName, typeof record.subject === "string" && GITHUB_SUBJECT.test(record.subject) ? `GitHub user ${record.subject}` : "GitHub user");
}

/** A stored person's picture for display: a GitHub person's only; Slack and company sign-in people have none. */
export function profileAvatarUrl(record: PersonLike): string | undefined {
  return record.provider === "github" ? githubAvatarUrl(record.issuer, record.subject) : undefined;
}
