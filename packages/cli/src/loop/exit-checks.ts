// rovara loop (#355, #356, #357, #358): the checks that run when the agent claims a step done. They read the item's
// worktree, so they run in the daemon, and the runtime gets only what failed.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactSchema, type Artifact, type ExitCheck } from "./definitions.js";
import { ARTIFACT_SECTIONS, SELF_REVIEW_SECTIONS } from "./instructions.js";
import { artifactPath, evidencePath } from "./naming.js";
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
  /** #358: where the item's evidence goes (docsDir); docs/rovara/<issue> by default. */
  docs?: string;
  /** #358: the issue's repository, and every repository the loop can work in on this computer. */
  repo?: string;
  registered?: readonly string[];
}

/** The most repositories one plan may change, each with its own pull request and agent. */
export const PLAN_REPOSITORIES_MAX = 10;

/**
 * #358: the repositories the plan's `## Repositories` section names, in order, once each: `- owner/name: what changes
 * there`. Undefined when the plan has no such section (it changes only the issue's repository).
 */
export function planRepositories(text: string): string[] | undefined {
  let inSection = false;
  let found: string[] | undefined;
  for (const line of text.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/u.exec(line);
    if (heading !== null) { inSection = (heading[1] ?? "").toLowerCase() === "repositories"; if (inSection) found ??= []; continue; }
    if (!inSection) continue;
    const entry = /^\s*[-*]\s+`?([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})`?/u.exec(line);
    if (entry?.[1] !== undefined && !found!.includes(entry[1])) found!.push(entry[1]);
  }
  return found;
}

/** #358: whether a plan's repositories need per-PR loops: it names a repository other than the issue's. */
export function splitTargets(text: string | undefined, home: string): string[] | undefined {
  const named = text === undefined ? undefined : planRepositories(text);
  return named !== undefined && named.some((repo) => repo !== home) ? named : undefined;
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
    if (check === "self-review") {
      const path = evidencePath(facts.issue, "self-review.md", facts.docs);
      const text = facts.worktree === undefined ? undefined : await readFile(join(facts.worktree, path), "utf8").catch(() => undefined);
      if (text === undefined) failures.push(`review your own change first, and record it at ${path}`);
      else {
        const missing = missingSections(text, SELF_REVIEW_SECTIONS);
        if (missing.length > 0) failures.push(`your self-review needs these sections, each with something in it (write "None" where there is nothing): ${missing.map((section) => `## ${section}`).join(", ")}`);
      }
    }
    if (check === "repositories" && facts.artifact !== undefined) {
      const named = planRepositories(await readArtifact(facts.worktree, facts.issue, facts.artifact) ?? "");
      if (named !== undefined) {
        const unknown = named.filter((repo) => repo !== facts.repo && !(facts.registered ?? []).includes(repo));
        if (named.length === 0) failures.push("the plan's ## Repositories names no repository; list each as `- owner/name: what changes there`, or remove the section if only this repository changes");
        else if (named.length > PLAN_REPOSITORIES_MAX) failures.push(`the plan names ${named.length} repositories; at most ${PLAN_REPOSITORIES_MAX} can each have a pull request`);
        else if (unknown.length > 0) failures.push(`the loop cannot work in ${unknown.join(", ")} on this computer: ask the person to run \`rovara loop add\` in ${unknown.length === 1 ? "its checkout" : "their checkouts"}, then call loop_complete again`);
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
