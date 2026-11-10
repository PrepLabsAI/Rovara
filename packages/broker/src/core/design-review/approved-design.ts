// Design review stage: the approved design in the spec write-back. Which design is approved, when the spec must wait for it, and the design's text laid out for the
// spec renderers (all four put `SpecDraft.design` under their own design heading: Kiro `design.md`, Spec Kit `plan.md`, the team template's design slot, Rovara `spec.md`).
// Only the APPROVED design's text goes in, and only text that hashes to the digest a person approved. Reviewer findings, questions, paraphrases and manifests are never an input here, so they cannot be written to the meta repo.
// PURE: no store, no network, no env var, no IAM. The write itself is the existing spec write-back (SPEC_WRITE result -> `acceptSpecWrite` -> `publishSpec`).
import { createHash } from "node:crypto";
import { specMarkdown, type WorkflowSnapshot } from "@agentx/contracts";

/** The approved design as the spec step gets it. */
export interface ApprovedSpecDesign {
  digest: string;
  text: string;
}

/** What the spec step does about design review: nothing (not on), wait (on, but no design is approved yet: nothing is written), or write this design. */
export type SpecDesignState = { kind: "off" } | { kind: "wait" } | { kind: "approved"; design: ApprovedSpecDesign };

/** The longest the design may be in the spec, after escaping (a design is at most 24 KB; a spec file is at most 64 KiB). Over it, the design is not written: a cut design is not the approved one. */
export const SPEC_APPROVED_DESIGN_MAX_CHARS = 48_000;

type DesignWorkflow = Pick<WorkflowSnapshot, "artifacts" | "decisions" | "designReview">;

/** The digest of the task's latest design document, when a person's approval names it (the broker's own automatic decisions are never an approval). Undefined otherwise. */
export function approvedDesignDigestOf(workflow: Pick<WorkflowSnapshot, "artifacts" | "decisions"> | undefined): string | undefined {
  if (workflow === undefined) return undefined;
  const design = workflow.artifacts.filter((artifact) => artifact.type === "design").at(-1);
  if (design === undefined) return undefined;
  const decided = workflow.decisions.some((decision) => decision.decision === "APPROVE" && decision.artifactDigest === design.sha256 && decision.actorRole !== "AGENTX");
  return decided ? design.sha256 : undefined;
}

/**
 * What the spec step does for this workflow. `designText` reads the latest design document's text (called only when a design is approved).
 * - design review not on for the task: `off` (the spec is written exactly as before);
 * - on, a design approved, its text read and hashing to the approved digest: `approved`;
 * - on, anything else (no approval yet, a design sent back, the text unreadable or not the approved one): `wait`. The spec is not written, and a wait is never turned into a guess.
 * - a review that did not run and has no design document at all (skipped, never started) has nothing to write: `off`.
 */
export function specDesignState(workflow: DesignWorkflow, designText: () => string | undefined): SpecDesignState {
  if (workflow.designReview === undefined) return { kind: "off" };
  const digest = approvedDesignDigestOf(workflow);
  if (digest === undefined) {
    return workflow.designReview.status === "not_run" && !workflow.artifacts.some((artifact) => artifact.type === "design") ? { kind: "off" } : { kind: "wait" };
  }
  let text: string | undefined;
  try {
    text = designText();
  } catch {
    text = undefined;
  }
  if (text === undefined || createHash("sha256").update(text, "utf8").digest("hex") !== digest) return { kind: "wait" };
  return { kind: "approved", design: { digest, text } };
}

/**
 * The approved design as the markdown that goes into `SpecDraft.design`: made safe the way every untrusted design text is (`specMarkdown`: headings become bold lines, markup is escaped, fences are rebuilt), with
 * one plain line first that names the digest. Undefined when the text does not hash to the digest or is too long to write whole.
 */
export function specDesignMarkdown(design: ApprovedSpecDesign): string | undefined {
  if (!/^[a-f0-9]{64}$/u.test(design.digest) || createHash("sha256").update(design.text, "utf8").digest("hex") !== design.digest) return undefined;
  const body = specMarkdown(design.text, Number.MAX_SAFE_INTEGER);
  if (body.trim() === "" || Array.from(body).length > SPEC_APPROVED_DESIGN_MAX_CHARS) return undefined;
  return `Approved design (digest ${design.digest.slice(0, 12)}).\n\n${body}`;
}
