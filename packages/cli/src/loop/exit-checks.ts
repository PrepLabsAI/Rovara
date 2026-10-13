// rovara loop (#355, #356): the checks that run when the agent claims a step done. They read the item's worktree,
// so they run in the daemon, and the runtime gets only what failed.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExitCheck } from "./definitions.js";
import { PLAN_SECTIONS } from "./instructions.js";
import { planPath } from "./naming.js";
import { SUMMARY_MAX } from "./runtime.js";

export interface ClaimFacts {
  summary: string;
  issue: number;
  worktree: string | undefined;
  /** The approved plan's digest, once a plan was approved. */
  planDigest: string | undefined;
}

/** The plan's text, or undefined when the worktree has none. */
export async function readPlan(worktree: string | undefined, issue: number): Promise<string | undefined> {
  if (worktree === undefined) return undefined;
  return readFile(join(worktree, planPath(issue)), "utf8").catch(() => undefined);
}

export function planDigest(plan: string): string {
  return createHash("sha256").update(plan).digest("hex");
}

/** The required sections the plan lacks, or leaves empty, in order. */
export function missingPlanSections(plan: string): string[] {
  const sections = new Map<string, string>();
  let current: string | undefined;
  for (const line of plan.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/u.exec(line);
    if (heading !== null) { current = (heading[1] ?? "").toLowerCase(); sections.set(current, ""); continue; }
    if (current !== undefined) sections.set(current, `${sections.get(current) ?? ""}${line.trim()}`);
  }
  return PLAN_SECTIONS.filter((section) => (sections.get(section.toLowerCase()) ?? "") === "");
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
    if (check === "plan-sections") {
      const plan = await readPlan(facts.worktree, facts.issue);
      if (plan === undefined) failures.push(`there is no plan at ${planPath(facts.issue)}; write it there`);
      else {
        const missing = missingPlanSections(plan);
        if (missing.length > 0) failures.push(`the plan needs these sections, each with something in it: ${missing.map((section) => `## ${section}`).join(", ")}`);
      }
    }
    if (check === "plan-unchanged" && facts.planDigest !== undefined) {
      const plan = await readPlan(facts.worktree, facts.issue);
      if (plan === undefined || planDigest(plan) !== facts.planDigest) failures.push(`the approved plan at ${planPath(facts.issue)} was changed; put it back as it was approved, and change only the code`);
    }
  }
  return failures;
}
