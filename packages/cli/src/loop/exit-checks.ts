// rovara loop (#355, #356, #357): the checks that run when the agent claims a step done. They read the item's
// worktree, so they run in the daemon, and the runtime gets only what failed.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactSchema, type Artifact, type ExitCheck } from "./definitions.js";
import { ARTIFACT_SECTIONS } from "./instructions.js";
import { artifactPath } from "./naming.js";
import { SUMMARY_MAX } from "./runtime.js";
import type { WorkItemState } from "./state.js";

export interface ClaimFacts {
  summary: string;
  issue: number;
  worktree: string | undefined;
  /** The artifact the claimed step writes, if any. */
  artifact: Artifact | undefined;
  /** Every artifact a gate approved, with its digest then. */
  approvals: WorkItemState["approvals"];
}

/** An artifact's text, or undefined when the worktree has none. */
export async function readArtifact(worktree: string | undefined, issue: number, artifact: Artifact): Promise<string | undefined> {
  if (worktree === undefined) return undefined;
  return readFile(join(worktree, artifactPath(issue, artifact)), "utf8").catch(() => undefined);
}

export function artifactDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The required sections `text` lacks, or leaves empty, in order. Headings are matched without regard to case. */
export function missingSections(text: string, required: readonly string[]): string[] {
  const sections = new Map<string, string>();
  let current: string | undefined;
  for (const line of text.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/u.exec(line);
    if (heading !== null) { current = (heading[1] ?? "").toLowerCase(); sections.set(current, ""); continue; }
    if (current !== undefined) sections.set(current, `${sections.get(current) ?? ""}${line.trim()}`);
  }
  return required.filter((section) => (sections.get(section.toLowerCase()) ?? "") === "");
}

/** Every approved artifact that no longer matches its approval: missing, or changed. */
export async function changedApprovals(worktree: string | undefined, issue: number, approvals: WorkItemState["approvals"]): Promise<Artifact[]> {
  const changed: Artifact[] = [];
  for (const artifact of ArtifactSchema.options) {
    const approval = approvals?.[artifact];
    if (approval === undefined) continue;
    const text = await readArtifact(worktree, issue, artifact);
    if (text === undefined || artifactDigest(text) !== approval.digest) changed.push(artifact);
  }
  return changed;
}

/** Every failed check of `checks`, as a sentence the agent can act on. */
export async function failedExitChecks(checks: readonly ExitCheck[], facts: ClaimFacts): Promise<string[]> {
  const failures: string[] = [];
  const summary = facts.summary.trim();
  for (const check of checks) {
    if (check === "require-summary") {
      if (summary === "") failures.push("give a summary of what you did; it is posted on the issue");
      else if (summary.length > SUMMARY_MAX) failures.push(`the summary is longer than ${SUMMARY_MAX} characters; shorten it`);
    }
    if (check === "artifact-sections" && facts.artifact !== undefined) {
      const path = artifactPath(facts.issue, facts.artifact);
      const text = await readArtifact(facts.worktree, facts.issue, facts.artifact);
      if (text === undefined) failures.push(`there is no ${facts.artifact} at ${path}; write it there`);
      else {
        const missing = missingSections(text, ARTIFACT_SECTIONS[facts.artifact]);
        if (missing.length > 0) failures.push(`the ${facts.artifact} needs these sections, each with something in it: ${missing.map((section) => `## ${section}`).join(", ")}`);
      }
    }
    if (check === "approved-unchanged") {
      for (const artifact of await changedApprovals(facts.worktree, facts.issue, facts.approvals)) {
        failures.push(`the approved ${artifact} at ${artifactPath(facts.issue, artifact)} ${artifact === "requirements" ? "were" : "was"} changed; put ${artifact === "requirements" ? "them" : "it"} back as approved`);
      }
    }
  }
  return failures;
}
