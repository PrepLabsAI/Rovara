// `GET /v1/dev/tasks/{taskId}/checks` (RD-2b1 fills it; RD-2.0 writes the shape): what proves the task's claims, for the new task page's Checks tab. The acceptance checks, each tied to the claims it proves and to its state for the task's
// current code; the Code and Security review rows with their findings; the pack's command output and screenshots as links; what was not tested. Built from the workflow snapshot and the kept evidence pack, not from the testing switch.
// Every member is optional and unknown members pass through (see task-read-common.ts). Until the lane fills it, Code answers `ROUTE_NOT_SERVED`.
import { z } from "zod";
import { LinkWireSchema, RanOnWireSchema, loose } from "./task-read-common.js";

/**
 * One check. `state`: not_run, running, passed, flaky, failed, unverified (could not be verified), out_of_date (ran on other code than the current), known_failing; read it as a string. `proves` names the plan claims it proves
 * (`1`, `1.1`); `what` is what the check does, in plain words. `before` and `after` are the result on the unchanged and the changed code (passed, failed, timed_out, or absent).
 */
export const CheckRowWireSchema = loose({
  id: z.string().nullish(),
  label: z.string().nullish(),
  kind: z.string().nullish(),
  state: z.string().nullish(),
  proves: z.array(z.string()).nullish(),
  what: z.string().nullish(),
  before: z.string().nullish(),
  after: z.string().nullish(),
  ranOn: RanOnWireSchema.nullish(),
  /** The failing tests with their likely cause (words, or "unknown (...)"). */
  failures: z.array(loose({ test: z.string().nullish(), cause: z.string().nullish() })).nullish(),
  failuresNotListed: z.number().nullish(),
  /** The command output's tail and the screenshots, as links Code serves (`/v1/app/tasks/{taskId}/evidence/{sha256}`, RD-2d); `retention` says when a file is gone (kept, expired). */
  output: LinkWireSchema.nullish(),
  screenshots: z.array(LinkWireSchema).nullish(),
  retention: z.string().nullish(),
});

/** A review row. `role`: code or security. `state`: not_run, running, passed, findings, unfinished. */
export const ReviewRowWireSchema = loose({
  role: z.string().nullish(),
  state: z.string().nullish(),
  findings: z.array(loose({ file: z.string().nullish(), line: z.number().nullish(), severity: z.string().nullish(), text: z.string().nullish(), accepted: z.boolean().nullish() })).nullish(),
});

export const TaskChecksReadSchema = loose({
  checks: loose({
    taskId: z.string().nullish(),
    /** The code the rows are about (the candidate's digest), and the commit and time of the latest run. */
    candidateDigest: z.string().nullish(),
    ranOn: RanOnWireSchema.nullish(),
    /** Each plan claim with the checks that prove it. */
    acceptance: z.array(loose({ claimId: z.string().nullish(), text: z.string().nullish(), checkIds: z.array(z.string()).nullish() })).nullish(),
    rows: z.array(CheckRowWireSchema).nullish(),
    reviews: z.array(ReviewRowWireSchema).nullish(),
    /** The security scan's findings (tool, counts), when the pack kept one. */
    securityScan: loose({ tool: z.string().nullish(), counts: z.record(z.string(), z.number()).nullish(), items: z.array(z.unknown()).nullish() }).nullish(),
    /** What the task did not test, in plain words. */
    notTested: z.array(z.string()).nullish(),
  }).nullish(),
});
export type TaskChecksRead = z.infer<typeof TaskChecksReadSchema>;

export const TASK_CHECKS_EXAMPLE = {
  checks: {
    taskId: "11111111-1111-4111-8111-111111111111",
    candidateDigest: "c".repeat(64),
    ranOn: { commit: "d".repeat(40), at: "2026-11-15T10:20:00.000Z" },
    acceptance: [{ claimId: "1", text: "Add GET /health", checkIds: ["unit"] }],
    rows: [
      { id: "unit", label: "Unit tests", kind: "test", state: "failed", proves: ["1", "1.1"], what: "Runs the unit tests of the service", before: "passed", after: "failed", failures: [{ test: "health.test.ts::answers 200", cause: "the change to src/health.ts" }], output: { kind: "output", href: "/v1/app/tasks/11111111-1111-4111-8111-111111111111/evidence/" + "e".repeat(64) }, retention: "kept" },
    ],
    reviews: [{ role: "code", state: "passed", findings: [] }, { role: "security", state: "findings", findings: [{ file: "src/health.ts", line: 4, severity: "medium", text: "The version is public", accepted: false }] }],
    notTested: ["The deploy script"],
  },
} as const;
