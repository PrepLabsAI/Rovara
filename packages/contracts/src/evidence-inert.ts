// Text that a pull request description, a check summary or a page shows to readers, made inert (TE-A2a). Everything an evidence pack holds that a repository, a person or an agent wrote goes through here before it is printed:
// nothing in it can mention or notify anyone, link anywhere, embed an image, cross-reference an issue, close a Linear issue, open a heading, quote or code block, or hide text. Browser-safe and pure.
import { redactText } from "./redaction.js";

/** A zero-width joiner: written after a character that would start a mention, link or issue reference, so it no longer does. */
const ZWJ = "\u200D";
/** The input is cut to this many characters per character of output before anything else is done, so a hostile megabyte costs the same as a short line. */
const INPUT_PER_OUTPUT = 4;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu;
/** Variation selectors (U+FE00 to U+FE0F, U+E0100 to U+E01EF): invisible, and not format characters, so `\p{Cf}` does not catch them. */
const VARIATION_SELECTORS = new RegExp("[\\uFE00-\\uFE0F\\u{E0100}-\\u{E01EF}]", "gu");
// An image or a link, with one level of brackets inside its text (`![a[b]c](url)`, `[x[1]](url)`).
const IMAGE = /!\[(?:[^[\]]|\[[^[\]]*\])*\]\([^()]*\)/gu;
const LINK = /\[((?:[^[\]]|\[[^[\]]*\])*)\]\([^()]*\)/gu;
// A line that would open a block when it starts one: heading, quote, list, rule, code fence, table, numbered list.
const BLOCK_START = /^(?:[#>|=+\-*_`~]|\d+[.)](?:\s|$))/u;

/**
 * One line of untrusted text made inert: cut first (before any work), redacted, control, format and invisible characters and line breaks gone, `&` and `<` written as entities, images dropped and links reduced to their text
 * (also with brackets inside), every bracket left over turned into a parenthesis (so no reference-style image, link or definition is possible), tags dropped, a joiner after every `@`, `://`, `www` and `#` before a digit
 * (no mention, link or issue reference), a Linear issue key (`ENG-42`) broken so "Fixes ENG-42" closes nothing, a joiner before anything that would open a block at the start of the line, and cut to `max` code points.
 */
export function inertEvidenceText(text: string, max: number): string {
  const head = text.slice(0, Math.max(1, max) * INPUT_PER_OUTPUT).replace(LONE_SURROGATE, "");
  let inert = redactText(head).replace(VARIATION_SELECTORS, "").replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim().replaceAll("&", "&amp;");
  for (let pass = 0; pass < 3; pass += 1) inert = inert.replace(IMAGE, "").replace(LINK, "$1");
  inert = inert
    .replace(/<((?:https?|mailto):[^>]*)>/giu, "$1")
    .replace(/<[^>]*>/gu, "")
    .replaceAll("<", "&lt;")
    .replaceAll("[", "(")
    .replaceAll("]", ")")
    .replaceAll("@", `@${ZWJ}`)
    .replaceAll("://", `://${ZWJ}`)
    .replace(/\bwww\./giu, (match) => `${match.slice(0, 3)}${ZWJ}.`)
    .replace(/#(?=\d)/gu, `#${ZWJ}`)
    .replace(/\b([A-Za-z][A-Za-z0-9]{0,9})-(?=\d)/gu, `$1-${ZWJ}`)
    .replace(/\s+/gu, " ")
    .trim();
  if (BLOCK_START.test(inert)) inert = `${ZWJ}${inert}`;
  const points = Array.from(inert);
  return points.length <= max ? inert : `${points.slice(0, max - 1).join("")}…`;
}
