// TE-A2b: the pull request description's Evidence block for a version 2 pack: the shared renderer's first line and body (contracts `renderEvidence`), as markdown. The description's writer version (`evidenceWriter`) is a
// parameter and its default is 1, which prints nothing here: the description is then what it was. The block is for a v2 pack bound to the code the description is about; a v1 pack, a later version, an unreadable pack
// and a pack for other code give none, and the description falls back to the lines it always had (including Rovara's own flags block).
//
// The flags (instruction files and files CI runs) and the weakening words come from the description's own changed files and the pack's test parts (`weakeningFactsOf`, TE-B3), the same facts the v1 description uses, so a
// description rewritten after a fix says what the code now on the pull request says; with no file list the pack's own `flags` and `weakening` parts are used. The words are `weakeningLines` (contracts), inside the renderer.
// Every word a repository wrote reaches the text through the renderer's inert text. Bounded: the full form is at most the renderer's limits, and a shrink level of 3 or more gives the compact form.
import { renderEvidence, type EvidencePackV2Read } from "@agentx/contracts";
import type { ProofEvidenceContext } from "./evidence-lines.js";
import { boundEvidence } from "./evidence-lines.js";
import type { ChangedFileEntry } from "./verification-report.js";
import { notComparedLine, weakeningFactsOf } from "./weakening-flags.js";
import type { WeakeningFacts } from "@agentx/contracts";

/** The heading of the block. */
export const EVIDENCE_V2_HEADING = "## Evidence";
/** From this shrink level the block is the compact form. */
export const EVIDENCE_V2_COMPACT_LEVEL = 3;

/** The v2 pack of the context, only when it is a v2 read for exactly this code. */
export function boundEvidenceV2(context: ProofEvidenceContext | undefined, candidateDigest: string | undefined): { pack: EvidencePackV2Read; newer: Extract<NonNullable<ProofEvidenceContext["read"]>, { status: "v2" }>["newer"] } | undefined {
  const read = context?.read;
  if (read === undefined || read.status !== "v2" || candidateDigest === undefined || read.pack.candidate.digest !== candidateDigest) return undefined;
  return { pack: read.pack, newer: read.newer };
}

/**
 * The pack's `weakening` and `flags` parts for some facts, in ONE place (the writer and the description both use it), so a change to the contract's shape is one edit. TE-B3's rules: a skip rise only when the skips really rose,
 * a count of tests that ran before and not now only when it is above zero, and a part at all only when it says something; no zero or empty shape is made up. The lists the strict schema requires inside a part that is given
 * are filled from the facts, whatever they hold. "Could not compare" is not a part of the pack: it is a line of the description (`evidenceV2Lines`, `notCompared`).
 */
export function weakeningPartsOf(facts: WeakeningFacts, fallbackRemoved: readonly string[] = []): { weakening?: EvidencePackV2Read["weakening"]; flags?: EvidencePackV2Read["flags"] } {
  const lists = { absentOnNew: [...(facts.absentOnNew ?? [])], changedTestConfig: [...(facts.changedTestConfig ?? [])], changedSnapshots: [...(facts.changedSnapshots ?? [])], changedFixtures: [...(facts.changedFixtures ?? [])] };
  const count = facts.absentOnNewCount;
  const rise = facts.skipRise !== undefined && facts.skipRise.after > facts.skipRise.before ? facts.skipRise : undefined;
  const says = rise !== undefined || (count ?? 0) > 0 || fallbackRemoved.length > 0 || Object.values(lists).some((list) => list.length > 0);
  const instructionFiles = [...(facts.instructionFiles ?? [])];
  const ciExecutedFiles = [...(facts.ciExecutedFiles ?? [])];
  return {
    ...(says ? { weakening: { ...(rise === undefined ? {} : { skipRise: { before: rise.before, after: rise.after } }), removedTests: [...fallbackRemoved], ...lists, ...((count ?? 0) > 0 ? { absentOnNewCount: count } : {}) } } : {}),
    ...(instructionFiles.length + ciExecutedFiles.length > 0 ? { flags: { instructionFiles, ciExecutedFiles } } : {}),
  };
}

const withoutParts = (pack: EvidencePackV2Read): EvidencePackV2Read => {
  const { weakening: _weakening, flags: _flags, ...rest } = pack;
  void _weakening; void _flags;
  return rest;
};

/** The renderer's lines as markdown: a line that is not a list item is its own paragraph (a plain line after a plain line would run into it), a list item follows the line before it. */
function asMarkdown(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (out.length > 0 && !line.startsWith("- ")) out.push("");
    out.push(line);
  }
  return out;
}

/**
 * The block's lines (heading, first line, body, then a blank line), or undefined when there is no v2 pack for this code. `level` is the description's shrink level. `notCompared` is the reason the test proof could not compare
 * the untouched tests (`notComparedReason`, given only when the description has a proof context): the block then ends with "Test weakening: could not compare (<reason>)", as the v1 flags block says it, so a missing flag
 * never reads as "nothing was weakened".
 */
export function evidenceV2Lines(context: ProofEvidenceContext | undefined, candidateDigest: string | undefined, files: readonly ChangedFileEntry[] | undefined, level: number, notCompared?: string): string[] | undefined {
  const bound = boundEvidenceV2(context, candidateDigest);
  if (bound === undefined) return undefined;
  const v1 = boundEvidence(context, candidateDigest);
  const facts = files === undefined || v1 === undefined ? undefined : weakeningFactsOf(files, v1);
  // With the description's own files the pack's weakening and flags are replaced by what those files and the pack's test parts say now; without them the pack's own are used.
  const pack = facts === undefined ? bound.pack : ({ ...withoutParts(bound.pack), ...weakeningPartsOf(facts, bound.pack.weakening?.removedTests ?? []) } as EvidencePackV2Read);
  const rendering = renderEvidence(pack, { newer: bound.newer, compact: level >= EVIDENCE_V2_COMPACT_LEVEL });
  return [EVIDENCE_V2_HEADING, ...asMarkdown([rendering.firstLine, ...rendering.body, ...(notCompared === undefined ? [] : [notComparedLine(notCompared)])]), ""];
}
