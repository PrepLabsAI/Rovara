// OWNER DECISION 18: the key facts a document's decision card shows, worked out from the document itself. A pure function: no model call, no clock, no storage, so the same document gives the same
// lines every time (they are part of the card's digest). Every line is redacted, one plain line, and bounded.
//   structured   what is needed: the document's title and the first sentence of its first "why"; what Rovara will do: its top-level claims in order, then (only while fewer than three) their
//                first sub-claims, at most five lines.
//   Markdown     what is needed: its first heading (or first line); what Rovara will do: the next lines with text, list markers and emphasis taken off, at most five.
import { DECISION_PLAN_SUMMARY_LINES_MAX, redactText, type PlanClaim } from "@agentx/contracts";
import type { LoadedDocument } from "../../developer/plan-document-reader.js";

const NEEDED_MAX = 300;
const LINE_MAX = 200;
const SUMMARY_MIN = 3;

/** One plain line of at most `max` characters, cut at a word; empty when nothing is left. */
function plain(text: string, max: number): string {
  const flat = redactText(text).replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  const characters = Array.from(flat);
  if (characters.length <= max) return flat;
  const head = characters.slice(0, max - 1).join("");
  const space = head.lastIndexOf(" ");
  return `${(space > max / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

function firstSentence(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  const end = /[.!?](?=\s|$)/u.exec(flat);
  return end === null ? flat : flat.slice(0, end.index + 1);
}

function claimLines(claims: readonly PlanClaim[]): string[] {
  const lines = claims.map((claim) => claim.text);
  // A plan with fewer than three points says more with its first sub-points than with two lines.
  for (const claim of claims) {
    for (const child of claim.children ?? []) {
      if (lines.length >= SUMMARY_MIN) break;
      lines.push(child.text);
    }
  }
  return lines;
}

/** A Markdown line as plain words: heading marks, list markers, emphasis and code marks taken off. */
const markdownWords = (line: string): string => line.replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d{1,3}[.)]\s+|>\s*)/u, "").replace(/[*_`~]+/gu, "").replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1");

/** What a card says the document needs and what Rovara will do, or undefined when the document cannot be read or says nothing usable. */
export function documentSummary(loaded: LoadedDocument | undefined): { needed: string; lines: string[] } | undefined {
  if (loaded === undefined) return undefined;
  let needed: string;
  let candidates: string[];
  if (loaded.format === "structured") {
    const plan = loaded.plan;
    const why = firstSentence(plan.why[0]?.text ?? "");
    needed = plain(why === "" ? plan.title : `${plan.title}: ${why}`, NEEDED_MAX);
    candidates = claimLines(plan.claims);
  } else {
    const lines = loaded.markdown.split(/\r?\n/u).filter((line) => !/^\s*(?:```|---|\|)/u.test(line)).map(markdownWords).map((line) => line.trim()).filter((line) => line !== "");
    needed = plain(lines[0] ?? "", NEEDED_MAX);
    candidates = lines.slice(1);
  }
  const lines = candidates.map((line) => plain(line, LINE_MAX)).filter((line) => line !== "").slice(0, DECISION_PLAN_SUMMARY_LINES_MAX);
  if (needed === "" || lines.length === 0) return undefined;
  return { needed, lines };
}
