// Text that GitHub shows to the repository's readers, made inert: nothing in it can mention or notify anyone, link anywhere, cross-reference an issue, embed an image, hide the rest of a
// description in a comment, or tell the next reader that a Rovara block starts or ends. It is used for every model-written, file-name or branch-name line of a pull request description.
import { redactText } from "@agentx/contracts";
import { neutralizeLinearWords } from "./linear-close.js";

/**
 * A model-written plan line made inert on GitHub: images dropped, links reduced to their text, URLs in angle brackets
 * unwrapped and other HTML tags dropped, and every @ followed by a zero-width joiner so no one is mentioned or notified.
 * A zero-width joiner also follows each `://` and `www`, so no bare URL becomes a link, and each `#` before a digit, so
 * no `#123` or `org/repo#123` cross-references an issue or pull request.
 */
export function inertPlanLine(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/<((?:https?|mailto):[^>]*)>/giu, "$1")
    .replace(/<[^>]*>/gu, "")
    .replaceAll("@", "@‍")
    .replaceAll("://", "://‍")
    .replace(/\bwww\./giu, (match) => `${match.slice(0, 3)}‍.`)
    .replace(/#(?=\d)/gu, "#‍")
    .trim();
}

/**
 * One line of untrusted text for a Rovara pull request description: redacted, with control and format characters and line breaks gone, `&` written as an entity, made inert, any `<` that is left
 * (an unclosed tag or comment) written as an entity so it cannot open a hidden comment, and cut to `max` characters (counted in code points).
 */
export function inertLine(text: string, max: number): string {
  const plain = redactText(text).replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  // `&` first: a character reference (`&#x40;user`, `&commat;user`) must stay text, not become an @ or a < after GitHub decodes it. Then an issue shorthand (`GH-123`) is broken up like `#123`, and a Linear magic word before an issue key (`Fixes ENG-123`, `Part of ENG-123`) is broken up so that no model-written line can close or link an issue (Plan 6 Task 20); keys and technical text are left as they are.
  const inert = neutralizeLinearWords(inertPlanLine(plain.replaceAll("&", "&amp;")).replaceAll("<", "&lt;").replace(/\bGH-(?=\d)/giu, (match) => `${match}\u200D`)).replace(/\s+/gu, " ").trim();
  const points = Array.from(inert);
  return points.length <= max ? inert : `${points.slice(0, max - 1).join("")}…`;
}
