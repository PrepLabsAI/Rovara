// TE-A2b: the pull request description's Evidence block for a version 2 pack: the shared renderer's first line and body (contracts `renderEvidence`), as markdown. The description's writer version (`evidenceWriter`) is a
// parameter and its default is 1, which prints nothing here: the description is then what it was. The block is for a v2 pack bound to the code the description is about; a v1 pack, a later version, an unreadable pack
// and a pack for other code give none, and the description falls back to the lines it always had (including Rovara's own flags block).
//
// The flags (instruction files and files CI runs) and the weakening words come from the description's own changed files and the pack's test parts (`weakeningFactsOf`, TE-B3), the same facts the v1 description uses, so a
// description rewritten after a fix says what the code now on the pull request says; with no file list the pack's own `flags` and `weakening` parts are used. The words are `weakeningLines` (contracts), inside the renderer.
// Every word a repository wrote reaches the text through the renderer's inert text. Bounded: the full form is at most the renderer's limits, and a shrink level of 3 or more gives the compact form.
import { renderEvidencePublic, renderEvidence, type EvidencePackV2Read } from "@agentx/contracts";
import type { ProofEvidenceContext } from "./evidence-lines.js";
import { boundEvidence } from "./evidence-lines.js";
import type { ChangedFileEntry } from "./verification-report.js";
import { weakeningFactsOf } from "./weakening-flags.js";
import type { WeakeningFacts } from "@agentx/contracts";

/** The heading of the block. */
export const EVIDENCE_V2_HEADING = "## Evidence";
/** From this shrink level the block is the compact form. */
export const EVIDENCE_V2_COMPACT_LEVEL = 3;

/** The v2 pack of the context, only when it is a v2 read for exactly this code. */
export function boundEvidenceV2(context: ProofEvidenceContext | undefined, candidateDigest: string | undefined): { pack: EvidencePackV2Read; newer: Extract<NonNullable<ProofEvidenceContext["read"]>, { status: "v2" }>["newer"] } | undefined {
  const read = context?.read;
  if (read === undefined || read.status !== "v2" || candidateDigest === undefined || read.pack.candidate.digest !== candidateDigest) return undefined;
  // Only a sealed round or the agent's sandbox is a Rovara run. A stored pack is read tolerantly, so one that claims a real run from a laptop, an imported result or a place this build does not know is not shown as evidence at all.
  const isolation = read.pack.producer.isolation as string;
  if (read.pack.level.reached === "rovara_real_run" && isolation !== "sealed" && isolation !== "sandbox") return undefined;
  return { pack: read.pack, newer: read.newer };
}

/** The longest changed-file path a pack's `flags` and `weakening` parts hold (the schema's line limit). */
export const EVIDENCE_PATH_MAX = 500;
/**
 * A changed-file path as the pack holds it: hidden and control characters (a newline, a bidirectional override) become a space, and a path longer than the schema reads keeps its END (the file name is what a reviewer
 * looks for) behind an ellipsis. A path with nothing left is dropped and counted in `dropped`. The flag was decided from the real path before this: cleaning never hides a flagged file.
 */
export function cleanPaths(paths: readonly string[], dropped?: { droppedPaths: number }): string[] {
  const out: string[] = [];
  for (const path of paths) {
    const clean = path.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim();
    if (clean === "") { if (dropped !== undefined) dropped.droppedPaths += 1; continue; }
    out.push(clean.length <= EVIDENCE_PATH_MAX ? clean : `…${clean.slice(clean.length - (EVIDENCE_PATH_MAX - 1))}`);
  }
  return out;
}

/**
 * The pack's `weakening` and `flags` parts for some facts, in ONE place (the writer and the description both use it), so a change to the contract's shape is one edit. TE-B3's rules: a skip rise only when the skips really rose,
 * a count of tests that ran before and not now only when it is above zero, and a part at all only when it says something; no zero or empty shape is made up. The lists the strict schema requires inside a part that is given
 * are filled from the facts, whatever they hold. "Could not compare" is not a part of the pack: it is a line of the description (`evidenceV2Lines`, `notCompared`).
 */
export function weakeningPartsOf(facts: WeakeningFacts, fallbackRemoved: readonly string[] = [], dropped?: { droppedPaths: number }): { weakening?: EvidencePackV2Read["weakening"]; flags?: EvidencePackV2Read["flags"] } {
  const paths = (list: readonly string[] | undefined) => cleanPaths(list ?? [], dropped);
  const lists = { absentOnNew: [...(facts.absentOnNew ?? [])], changedTestConfig: paths(facts.changedTestConfig), changedSnapshots: paths(facts.changedSnapshots), changedFixtures: paths(facts.changedFixtures) };
  const count = facts.absentOnNewCount;
  const rise = facts.skipRise !== undefined && facts.skipRise.after > facts.skipRise.before ? facts.skipRise : undefined;
  const says = rise !== undefined || (count ?? 0) > 0 || fallbackRemoved.length > 0 || Object.values(lists).some((list) => list.length > 0);
  const instructionFiles = paths(facts.instructionFiles);
  const ciExecutedFiles = paths(facts.ciExecutedFiles);
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
 * The block's lines (heading, first line, body, then a blank line), or undefined when there is no v2 pack for this code. `level` is the description's shrink level. `notCompared` holds the lines for checks the test proof could not compare
 * the untouched tests (`notComparedLines`, given only when the description has a proof context): the block keeps each line, as the v1 flags block does, so a missing flag
 * never reads as "nothing was weakened".
 */
export function evidenceV2Lines(context: ProofEvidenceContext | undefined, candidateDigest: string | undefined, files: readonly ChangedFileEntry[] | undefined, level: number, notCompared: readonly string[] = []): string[] | undefined {
  const bound = boundEvidenceV2(context, candidateDigest);
  if (bound === undefined) return undefined;
  const v1 = boundEvidence(context, candidateDigest);
  const facts = files === undefined || v1 === undefined ? undefined : weakeningFactsOf(files, v1);
  // With the description's own files the pack's weakening and flags are replaced by what those files and the pack's test parts say now; without them the pack's own are used.
  const pack = facts === undefined ? bound.pack : ({ ...withoutParts(bound.pack), ...weakeningPartsOf(facts, bound.pack.weakening?.removedTests ?? []) } as EvidencePackV2Read);
  const rendering = renderEvidence(pack, { newer: bound.newer, compact: level >= EVIDENCE_V2_COMPACT_LEVEL, questionLimit: level === 0 ? 10 : level === 1 ? 5 : level === 2 ? 2 : 0 });
  return [EVIDENCE_V2_HEADING, ...asMarkdown([rendering.firstLine, ...rendering.body, ...notCompared]), ""];
}

/** Public AI summary only when the optional section exists; older public bodies remain byte-identical. */
export function evidencePublicAiLines(context: ProofEvidenceContext | undefined, candidateDigest: string | undefined): string[] | undefined {
  const bound = boundEvidenceV2(context, candidateDigest);
  if (bound === undefined || bound.pack.ai === undefined) return undefined;
  const rendering = renderEvidencePublic(bound.pack, { newer: bound.newer });
  // The shared public renderer puts AI first. Stop at its final summary line;
  // the rest of the B12 summary is not part of this optional PR addition.
  const end = rendering.body.findIndex(line => line.startsWith("Real-model run:"));
  const aiLines = rendering.body.slice(0, end === -1 ? 1 : end + 1);
  const headline = rendering.firstLine.startsWith("Worse on eval") ? [rendering.firstLine] : [];
  return [EVIDENCE_V2_HEADING, ...asMarkdown([...headline, ...aiLines]), ""];
}
