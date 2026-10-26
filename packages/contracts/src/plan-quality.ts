import { z } from "zod";
import { E2E_DISPLAY_ASSERTION_KINDS } from "./e2e-view.js";

/**
 * Plan quality findings: what the broker's plan self-check says is wrong, or missing, in a coding plan that parsed.
 * A finding is fixed codes and IDs only; both of its sentences are built here from fixed text and those IDs, so model
 * text (a label, a command, an expected value) can never reach Slack or the next planner prompt through a finding.
 */

export const PLAN_QUALITY_CODES = [
  /** A requested target runs the app but the plan selects no stand-in service (mock) for it, though the planning context offers one. */
  "mock-missing-for-target",
  /** A scenario lists a component as real that the plan also mocks on the same target (approval refuses that). */
  "real-component-mocked",
  /** An AI navigation step may take more actions than the request (or the route) allows. */
  "agent-budget-exceeded",
  /** A claim that says something is hidden has no scenario asserting it is not visible. */
  "hidden-assertion-missing",
  /** The plan says no check applies, so its claims have no proof (shown to the owner; not worth an automatic revision). */
  "checks-waived",
  /** A claim or Not changing entry that no runtime check proves. */
  "claim-not-covered",
  /** A claim or Not changing entry proved only by checks that read files. */
  "claim-static-only",
  /** The plan (or the request) needs a step or assertion kind that this project revision does not offer. */
  "e2e-kind-unavailable",
  /** The plan (or the request) needs a target that cannot run application scenarios now. */
  "e2e-target-unavailable",
  /** A proposed check's command is of a form known to give the wrong answer. */
  "check-command-lint",
  /** A proposed check could not run on the unchanged code (written by the dry run). */
  "check-broken-on-base",
  /** A proposed check did not do on the unchanged code what the plan predicted (written by the dry run). */
  "check-base-mismatch",
  /** A scenario that proves a Not changing entry fails on the unchanged code (written by the grounding round). */
  "scenario-base-mismatch",
] as const;
export type PlanQualityCode = (typeof PLAN_QUALITY_CODES)[number];

/** The forms of command `check-command-lint` knows. */
export const PLAN_QUALITY_LINTS = [
  "grep-files-without-match-count",
  "grep-files-without-match",
  "grep-count-absence",
  "grep-absence",
  "grep-invert-match",
  "grep-count",
  "exit-ignores-match",
  "quoted-literal",
] as const;
export type PlanQualityLint = (typeof PLAN_QUALITY_LINTS)[number];

/** Why a target cannot run application scenarios, as the planning context names it (anything else reads as `runtime-unavailable`). */
export const PLAN_QUALITY_TARGET_REASONS = ["runtime-unavailable", "no-launch-recipe", "needs-project-contract", "runtime-not-ready", "no-source-identity", "no-account-definition", "not-offered"] as const;
export type PlanQualityTargetReason = (typeof PLAN_QUALITY_TARGET_REASONS)[number];

/** Findings the planner can fix by writing the plan again; the others need a person (or a new project revision). */
const REVISABLE: Record<PlanQualityCode, boolean> = {
  "mock-missing-for-target": true,
  "real-component-mocked": true,
  "agent-budget-exceeded": true,
  "hidden-assertion-missing": true,
  "checks-waived": false,
  "claim-not-covered": true,
  "claim-static-only": true,
  "e2e-kind-unavailable": false,
  "e2e-target-unavailable": false,
  "check-command-lint": true,
  "check-broken-on-base": true,
  "check-base-mismatch": true,
  "scenario-base-mismatch": true,
};

const FindingIds = z.array(z.string().min(1).max(120)).max(32).optional();
export const PlanQualityFindingSchema = z.object({
  code: z.enum(PLAN_QUALITY_CODES),
  revisable: z.boolean(),
  scenarioIds: FindingIds,
  targetIds: FindingIds,
  claimIds: FindingIds,
  checkIds: FindingIds,
  fixtureIds: FindingIds,
  /** The step or assertion kinds an `e2e-kind-unavailable` finding names. */
  kinds: FindingIds,
  lint: z.enum(PLAN_QUALITY_LINTS).optional(),
  /** The most actions an agent step may take (`agent-budget-exceeded`). */
  limit: z.number().int().min(1).max(100).optional(),
  /** How many claims and Not changing entries a `checks-waived` finding leaves without proof. */
  count: z.number().int().min(0).max(1_000).optional(),
  targetReason: z.enum(PLAN_QUALITY_TARGET_REASONS).optional(),
  /** T7b: the scenario steps a `scenario-base-mismatch` finding names: the scenario, the assertion kind that failed and, when the verification names it, the step. Fixed fields only. */
  steps: z.array(z.object({ scenarioId: z.string().min(1).max(120), assertionKind: z.enum(E2E_DISPLAY_ASSERTION_KINDS), stepIndex: z.number().int().min(0).max(1_000).optional() }).strict()).max(32).optional(),
  /** For the owner: one fixed sentence. */
  ownerSentence: z.string().min(1).max(1_000),
  /** For the planner's next prompt: one line from plan IDs and fixed text. */
  plannerLine: z.string().min(1).max(1_000),
}).strict();
export type PlanQualityFinding = z.infer<typeof PlanQualityFindingSchema>;

export type PlanQualityFindingInput = {
  code: PlanQualityCode;
  scenarioIds?: readonly string[];
  targetIds?: readonly string[];
  claimIds?: readonly string[];
  checkIds?: readonly string[];
  fixtureIds?: readonly string[];
  kinds?: readonly string[];
  lint?: PlanQualityLint;
  limit?: number;
  count?: number;
  targetReason?: PlanQualityTargetReason;
  steps?: ReadonlyArray<{ scenarioId: string; assertionKind: (typeof E2E_DISPLAY_ASSERTION_KINDS)[number]; stepIndex?: number }>;
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const SHOWN_IDS = 5;
/** IDs as words: an ID with odd characters shows as "(unnamed)"; past five, "and N more". */
function idList(ids: readonly string[] | undefined): string {
  const safe = (ids ?? []).map((id) => (SAFE_ID.test(id) ? id : "(unnamed)"));
  if (safe.length === 0) return "(none)";
  return safe.length <= SHOWN_IDS ? safe.join(", ") : `${safe.slice(0, SHOWN_IDS).join(", ")} and ${safe.length - SHOWN_IDS} more`;
}

/** A claim ID as the owner reads it: `nc2` is the second Not changing entry. */
function claimWords(ids: readonly string[] | undefined): string {
  return idList(ids).replace(/\bnc([1-9][0-9]{0,2})\b/g, "Not changing $1");
}

const LINT_SENTENCES: Record<PlanQualityLint, { owner: string; planner: string }> = {
  "grep-files-without-match-count": {
    owner: "uses grep -L together with -c, which prints counts and gives an exit code that means different things on different systems",
    planner: "uses grep -L together with -c; this combination cannot test anything reliably",
  },
  "grep-files-without-match": {
    owner: "uses grep -L, whose exit code changed between grep versions, so it can pass or fail for the wrong reason",
    planner: "uses grep -L, whose exit code is not the same on every grep version",
  },
  "grep-count-absence": {
    owner: "counts matches with grep -c to prove that something is absent, but grep -c exits with failure when there are none",
    planner: "uses grep -c to test absence; grep -c exits 1 when the count is zero, so the check fails when the text is absent",
  },
  "grep-absence": {
    owner: "uses grep to prove that something is absent, but a plain grep passes only when the text is found",
    planner: "uses grep to test absence; grep passes only when the text is found",
  },
  "grep-invert-match": {
    owner: "uses grep -v, which passes whenever any other line exists, so it does not show that the text is absent",
    planner: "uses grep -v; it passes when any other line exists, which does not prove absence",
  },
  "grep-count": {
    owner: "uses grep -c, whose count the exit code ignores, so -q says the same thing more clearly",
    planner: "uses grep -c; the count is not used by the exit code, so use -q (or a file-contains check)",
  },
  "exit-ignores-match": {
    owner: "ends with a command (sed, awk, wc, head...) that succeeds whether or not the text is found, so it can pass without proving anything",
    planner: "ends with a command that exits 0 whether or not the text is found (sed, awk, wc, head, tail, cut, sort, jq without -e)",
  },
  "quoted-literal": {
    owner: "searches for text with a quote mark in it, but the quote style in source files (single, double or template) is not stable",
    planner: "searches for text with a quote mark in it; match the part without quotes instead",
  },
};

const TARGET_REASON_SENTENCES: Record<PlanQualityTargetReason, string> = {
  "runtime-unavailable": "its runtime is not set up for this project revision. Run project setup-approve, then close and restart the task.",
  "no-launch-recipe": "the project has no recipe that starts it. Run project setup-approve, then close and restart the task.",
  "needs-project-contract": "its test accounts are not described by a project contract. Run project setup-approve, then close and restart the task.",
  "runtime-not-ready": "its runtime is not ready now. Wait for the runtime to be qualified, then close and restart the task.",
  "no-source-identity": "its application has no package or project file that names it. Add one, then close and restart the task.",
  "no-account-definition": "no usable test account is registered for it. Run project setup-approve, then close and restart the task.",
  "not-offered": "this project revision does not offer it. Run project setup-approve, then close and restart the task.",
};

/** The reason string the planning context gives, as one this module has a sentence for. */
export function planQualityTargetReason(reason: string | undefined): PlanQualityTargetReason {
  return (PLAN_QUALITY_TARGET_REASONS as readonly string[]).includes(reason ?? "") ? (reason as PlanQualityTargetReason) : "runtime-unavailable";
}

function sentences(input: PlanQualityFindingInput): { owner: string; planner: string } {
  switch (input.code) {
    case "mock-missing-for-target":
      return {
        owner: `The plan selects no stand-in service for ${idList(input.targetIds)}, though one is offered (${idList(input.fixtureIds)}). Its checks may call the real service.`,
        planner: `mock-missing-for-target: no mockFixtureRefs entry for target ${idList(input.targetIds)}; offered for it: ${idList(input.fixtureIds)}. Add one entry per target that runs the app.`,
      };
    case "real-component-mocked":
      return {
        owner: `On ${idList(input.targetIds)} the plan both uses a stand-in for ${idList(input.fixtureIds)} and requires the real one (${idList(input.scenarioIds)}). The approval will refuse that.`,
        planner: `real-component-mocked: target ${idList(input.targetIds)} has a mockFixtureRefs entry for ${idList(input.fixtureIds)}, and scenario ${idList(input.scenarioIds)} lists it in requiredRealComponentIds. Remove one of them.`,
      };
    case "agent-budget-exceeded":
      return {
        owner: `An AI navigation step in ${idList(input.scenarioIds)} may take more than ${String(input.limit ?? 8)} actions, which is the most allowed.`,
        planner: `agent-budget-exceeded: scenario ${idList(input.scenarioIds)} has an agent step with maxActions above ${String(input.limit ?? 8)}. Lower it to ${String(input.limit ?? 8)} or less.`,
      };
    case "hidden-assertion-missing":
      return {
        owner: `${claimWords(input.claimIds)} says something is hidden, but no check asserts that it is not visible.`,
        planner: `hidden-assertion-missing: ${idList(input.claimIds)} says something is hidden, but no scenario that proves it has a "visible" assertion with equals false. Add one for the account that must not see it.`,
      };
    case "checks-waived":
      return {
        owner: `The plan says no check applies, so ${String(input.count ?? 0)} claims have no proof.`,
        planner: `checks-waived: the plan says no check applies; ${String(input.count ?? 0)} claims and Not changing entries have no proof.`,
      };
    case "claim-not-covered":
      return {
        owner: `Nothing in the plan checks ${claimWords(input.claimIds)} by running the app or its code.`,
        planner: `claim-not-covered: ${idList(input.claimIds)} is proved by no check. Add a scenario (list it in scenarioProves) or a proposed check that runs code and names it in proves.`,
      };
    case "claim-static-only":
      return {
        owner: `${claimWords(input.claimIds)} is checked only by reading files, not by running the app or its code.`,
        planner: `claim-static-only: ${idList(input.claimIds)} is proved only by checks that read files. Add a scenario (list it in scenarioProves) or a proposed check that runs code.`,
      };
    case "e2e-kind-unavailable": {
      const agent = (input.kinds ?? []).includes("agent");
      return {
        owner: agent
          ? "AI navigation steps are off for this project revision: its AI route is not approved. Run project setup-approve, then close and restart the task."
          : `This project revision cannot run ${idList(input.kinds)} checks. Run project setup-approve, then close and restart the task.`,
        planner: `e2e-kind-unavailable: ${idList(input.kinds)} is not offered by this project revision; write the scenario without it.`,
      };
    }
    case "e2e-target-unavailable": {
      const reason = TARGET_REASON_SENTENCES[input.targetReason ?? "runtime-unavailable"];
      return {
        owner: `The browser or API checks cannot run on ${idList(input.targetIds)}: ${reason}`,
        planner: `e2e-target-unavailable: ${idList(input.targetIds)} cannot run application scenarios now; do not rely on it.`,
      };
    }
    case "check-command-lint": {
      const lint = LINT_SENTENCES[input.lint ?? "grep-absence"];
      return {
        owner: `The proposed check ${idList(input.checkIds)} ${lint.owner}. A file-contains or file-does-not-contain check says it exactly.`,
        planner: `check-command-lint: check ${idList(input.checkIds)} ${lint.planner}. Use a "file-contains" or "file-not-contains" check (kind, cwd, path, text) instead.`,
      };
    }
    case "check-broken-on-base":
      return {
        owner: `The proposed check ${idList(input.checkIds)} could not run on the current code.`,
        planner: `check-broken-on-base: check ${idList(input.checkIds)} could not run on the unchanged code (broken command, not a failed assertion). Fix the command.`,
      };
    case "check-base-mismatch":
      return {
        owner: `The proposed check ${idList(input.checkIds)} did not do on the current code what the plan said it would.`,
        planner: `check-base-mismatch: check ${idList(input.checkIds)} gave a different result on the unchanged code than its expectOnBase says. Correct expectOnBase or the check.`,
      };
    case "scenario-base-mismatch": {
      // The assertion kinds are a fixed enum, so they are safe words; nothing the app showed or the plan wrote goes into a sentence.
      const kinds = [...new Set((input.steps ?? []).map((step) => step.assertionKind))];
      const which = kinds.length === 0 ? "" : ` (the ${kinds.join(", ")} check)`;
      return {
        owner: `The current app does not behave as the plan assumes for ${idList(input.scenarioIds)}${which}, which should stay unchanged.`,
        planner: `scenario-base-mismatch: scenario ${idList(input.scenarioIds)}${which} fails on the unchanged app although it proves a Not changing entry. Correct its expected values from the current code.`,
      };
    }
  }
}

/** A finding for the given code and IDs, with its two sentences. */
export function planQualityFinding(input: PlanQualityFindingInput): PlanQualityFinding {
  const text = sentences(input);
  const ids = (name: "scenarioIds" | "targetIds" | "claimIds" | "checkIds" | "fixtureIds" | "kinds") => (input[name] === undefined ? {} : { [name]: [...input[name]] });
  return {
    code: input.code,
    revisable: REVISABLE[input.code],
    ...ids("scenarioIds"), ...ids("targetIds"), ...ids("claimIds"), ...ids("checkIds"), ...ids("fixtureIds"), ...ids("kinds"),
    ...(input.lint === undefined ? {} : { lint: input.lint }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.count === undefined ? {} : { count: input.count }),
    ...(input.targetReason === undefined ? {} : { targetReason: input.targetReason }),
    ...(input.steps === undefined ? {} : { steps: input.steps.map((step) => ({ ...step })) }),
    ownerSentence: text.owner,
    plannerLine: text.planner,
  };
}

/** The findings the planner can fix by writing the plan again. */
export function revisablePlanQualityFindings(findings: readonly PlanQualityFinding[]): PlanQualityFinding[] {
  return findings.filter((finding) => finding.revisable);
}
