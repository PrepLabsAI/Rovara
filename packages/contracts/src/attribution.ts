// Plug-in foundations, task I3: who a change was made for. Rovara writes to a code host as a service identity the customer owns; a person's own account is not
// the author. So every write says whose request it was and who approved the plan.
//
// Where each thing goes (owner ruling on erasure, 2026-10-31: an erased person is never named, and nothing may be traced back to them):
//   - the COMMIT carries only a random reference per attribution (`Requested-by: rovara-ref <16 hex>`). It is not the person's id, not derived from it, and not a hash of anything:
//     it means something only through a row the broker keeps, which erasure deletes, after which the reference leads nowhere. Git history cannot be rewritten, so nothing about
//     the person may be in it that outlives that row.
//   - the CHANGE REQUEST'S DESCRIPTION carries the names (a display name, never an email address). A description can be edited, so erasure rewrites the person's line to
//     "a former member" (`rewriteAttributionBody`).
// Nothing here comes from the host, a model or a request body: the broker builds it from its own records (`broker/src/attribution`), and a person who has been erased, has left,
// or whose record could not be read is "a former member" from the start. The text is built here, once, so that the commit and the description agree and a forged line cannot pass as
// Rovara's: `withAttributionTrailers` removes any reserved trailer a message already carries (look-alike spellings included) before it adds the real ones.
import { z } from "zod";

/** A name as it is written to a host: letters, marks, digits, spaces and . , ' - only. No markup, mention, link, address, quote, newline or control character can be in it. */
const NAME = /^[\p{L}\p{M}\p{N}](?:[\p{L}\p{M}\p{N} .,'’-]{0,78}[\p{L}\p{M}\p{N}.])?$/u;
export const ATTRIBUTION_NAME_MAX = 80;
/** The length of the random reference on a commit. It is generated for each attribution; it is never cut from, or computed from, anything about the person. */
export const ATTRIBUTION_REF_LENGTH = 16;

export const AttributionPersonSchema = z.union([
  z.object({
    state: z.literal("named"),
    name: z.string().min(1).max(ATTRIBUTION_NAME_MAX).regex(NAME).refine((name) => !/ {2}/u.test(name), "one space between words"),
    ref: z.string().regex(/^[a-f0-9]{16}$/u),
  }).strict(),
  // A person who has been erased, or is no longer a member, or whose record could not be read: no name, no reference.
  z.object({ state: z.literal("former") }).strict(),
]);
export type AttributionPerson = z.infer<typeof AttributionPersonSchema>;

export const ActingAttributionSchema = z.object({
  /** Whose request the work was. Absent when no member asked (an automatic run). */
  requester: AttributionPersonSchema.optional(),
  /** Who approved the plan. Absent when no person did. */
  approver: AttributionPersonSchema.optional(),
  /** Where an authorized person finds the audit record of this change. https only, no credentials. */
  auditUrl: z.string().max(2_048).refine((value) => {
    try { const url = new URL(value); return url.protocol === "https:" && url.username === "" && url.password === ""; } catch { return false; }
  }, "an https link without credentials").optional(),
}).strict();
export type ActingAttribution = z.infer<typeof ActingAttributionSchema>;

/** The reserved trailer tokens. A message never keeps one of these from anywhere but Rovara. */
export const ATTRIBUTION_TRAILER_TOKENS = ["Requested-by", "Approved-by"] as const;

const FORMER = "a former member";
/** What a commit says of a person: only the random reference (or that they are a former member). Never a name. */
const personText = (person: AttributionPerson): string => (person.state === "named" ? `rovara-ref ${person.ref}` : FORMER);
const personName = (person: AttributionPerson): string => (person.state === "named" ? person.name : FORMER);

/** The trailer lines, `Requested-by` first. Empty when the attribution names no one. The value is checked again here, so a hand-built object cannot carry a forged line. */
export function attributionTrailers(attribution: ActingAttribution): string[] {
  const checked = ActingAttributionSchema.parse(attribution);
  return [
    ...(checked.requester === undefined ? [] : [`Requested-by: ${personText(checked.requester)}`]),
    ...(checked.approver === undefined ? [] : [`Approved-by: ${personText(checked.approver)}`]),
  ];
}

const RESERVED = new RegExp(`^(?:${ATTRIBUTION_TRAILER_TOKENS.join("|")})\\s*:`, "iu");
/** Letters of other alphabets that look like a Latin letter of a trailer token (Cyrillic and Greek), folded to it. A small table, not a full confusables list: the token has few letters. */
const CONFUSABLE: Readonly<Record<string, string>> = {
  "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p", "\u0441": "c", "\u0445": "x", "\u0443": "y", "\u0456": "i", "\u0455": "s", "\u0501": "d", "\u051b": "q", "\u0475": "v", "\u04bb": "h",
  "\u03bf": "o", "\u03bd": "v", "\u03c1": "p", "\u03b1": "a", "\u03b5": "e", "\u03b9": "i", "\u03ba": "k", "\u03c4": "t", "\u03c5": "u",
};
/**
 * The line as a reader would take it: compatibility-normalised, invisible characters removed, every kind of hyphen and dash written as `-`, and look-alike letters of other alphabets
 * written as the Latin letter. So `Requested\u2010by:`, `Requested-\u200Bby:` and `R\u0435quested-by:` are all recognised as the reserved token they imitate.
 */
const readAs = (line: string): string => line.normalize("NFKC")
  .replace(/[\u00AD\u200B-\u200F\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/gu, "")
  .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/gu, "-")
  .toLowerCase().replace(/[\u0370-\u03ff\u0400-\u052f]/gu, (char) => CONFUSABLE[char] ?? char)
  .trimStart();

const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*\s*:\s/u;

/**
 * The commit message with the attribution trailers at its end, in the message's own trailer block when it ends with one (git's rule: the last paragraph, every line a trailer).
 * Any line that already claims a reserved trailer is removed first, so a title or a model's text cannot pose as the requester. Idempotent. No attribution: the message as it was.
 */
export function withAttributionTrailers(message: string, attribution: ActingAttribution | undefined): string {
  if (attribution === undefined) return message;
  const trailers = attributionTrailers(attribution);
  if (trailers.length === 0) return message;
  const kept = message.replace(/\r\n?/gu, "\n").split("\n").filter((line) => !RESERVED.test(readAs(line)));
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
  const lastBreak = kept.lastIndexOf("");
  const lastParagraph = kept.slice(lastBreak + 1);
  const endsWithTrailers = lastBreak > 0 && lastParagraph.length > 0 && lastParagraph.every((line) => TRAILER_LINE.test(line));
  return `${[...kept, ...(endsWithTrailers || kept.length === 0 ? [] : [""]), ...trailers].join("\n")}\n`;
}

/** The lines for the change request's description: who asked, who approved the plan, where the audit record is. Empty when the attribution names no one. */
export function attributionBodyLines(attribution: ActingAttribution | undefined): string[] {
  if (attribution === undefined) return [];
  const checked = ActingAttributionSchema.parse(attribution);
  if (checked.requester === undefined && checked.approver === undefined) return [];
  return [
    ...(checked.requester === undefined ? [] : [`Requested by: ${personName(checked.requester)}`]),
    ...(checked.approver === undefined ? [] : [`Plan approved by: ${personName(checked.approver)}`]),
    ...(checked.auditUrl === undefined ? [] : [`Audit record: ${checked.auditUrl}`]),
  ];
}

/**
 * A subject line from a title: one line, no control or format characters, bounded. A title can come from a person or a model, and a newline in it would start a new paragraph of the
 * commit message, where a forged trailer could sit beside Rovara's own.
 */
export function commitSubject(title: string, max = 200): string {
  const plain = title.normalize("NFC").replace(/[\p{Cc}\p{Cf}\u2028\u2029\s]+/gu, " ").trim();
  const points = Array.from(plain);
  return points.length <= max ? plain : `${points.slice(0, max - 1).join("")}\u2026`;
}

/**
 * A change request's description with the lines that name a person rewritten to "a former member": the line for `role` is replaced whatever name it holds, because the
 * erasure that calls this knows from its link row which task the person was requester or approver of, and a description names nobody else on those lines. Idempotent.
 */
export function rewriteAttributionBody(body: string, role: "requester" | "approver"): string {
  const prefix = role === "requester" ? "Requested by: " : "Plan approved by: ";
  return body.split("\n").map((line) => (line.startsWith(prefix) && line !== `${prefix}${FORMER}` ? `${prefix}${FORMER}` : line)).join("\n");
}
