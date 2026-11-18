// DEC 253q(a), 253o(1): the setup run's eval discovery PRODUCER. The setup agent DRAFTS the eval definition in its final proposal answer (an `eval` member, `setupAgentInstructions`); this
// module turns that draft into the `eval_discovery` report the run sends through its existing setup callback. A person then confirms it on the setup page; the broker stores it and builds the
// eval plan from its own reads (`broker/src/core/setup-agent/eval-discovery.ts`).
//
// Deterministic and bounded, and whole or nothing (a draft that fails any rule gives NO report, never a partial one):
//   - the draft is at most EVAL_DISCOVERY_REPORT_MAX_BYTES of JSON and strict (unknown members refused): at most 4 suites and the report schema's own bounds;
//   - every question file must sit inside an eval suite F4 found (`discoverEvals`: an `evals`/`evaluations` folder, a known eval config or a question report) in the same repository, so a draft
//     cannot point the eval at arbitrary files;
//   - every question file and the judge's scoring file must be TRACKED at the run's resolved commit (the broker reads them there on confirm);
//   - what the draft does not decide is the worker's own: the catalog row and route (the eval product route's), the image (the worker's own pinned image, `AGENTX_WORKER_IMAGE`; a tag gives no
//     report) and the command fingerprint (computed here); judge pins are never sent (the broker computes them, DEC 253q);
//   - suites are ordered by selection and questions by id, so the same draft and repository give the same report bytes.
// Nothing here runs a command, reads a file's content or logs repository text; refusals are fixed words.
import {
  EVAL_DISCOVERY_CALLS_PER_QUESTION_MAX, EVAL_DISCOVERY_COST_PER_QUESTION_MAX_MICROS, EVAL_DISCOVERY_REPORT_MAX_BYTES, EVAL_DISCOVERY_SUITES_MAX, EVAL_PINNED_IMAGE, EVAL_PRODUCT_ROUTE, EVAL_PRODUCT_ROW, EVAL_QUESTION_LIMIT,
  EvalCommandSchema, EvalDiscoveryQuestionSchema, EvalJudgeSchema, EvalOutputShapeSchema, EvalReportPathSchema, SetupEvalDiscoveryReportSchema, canonicalJson, evalCommandFingerprintOf, type SetupEvalDiscoveryReport,
} from "@agentx/contracts";
import { z } from "zod";
import { discoverEvals, type EvalDiscovery } from "./eval-discovery.js";

const name = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:/@+-]+$/u);
/** One suite as the setup agent drafts it: everything a person confirms, and nothing the worker or the broker decides. */
const DraftSuiteSchema = z.object({
  selection: z.string().min(1).max(512).regex(/^[^\p{Cc}\p{Cf}]+$/u),
  repository: z.string().trim().min(1).max(200).optional(),
  questions: z.array(EvalDiscoveryQuestionSchema).min(1).max(EVAL_QUESTION_LIMIT),
  command: EvalCommandSchema,
  report: EvalReportPathSchema,
  /** L4-EVW2: what the command writes at `report`, when it is not a file Rovara already reads. The broker decides what to do with it (a wrapper proposal); nothing here runs or writes it. */
  output: EvalOutputShapeSchema.optional(),
  model: name,
  modelVersion: name,
  judge: EvalJudgeSchema,
  subsetSupported: z.boolean(),
  maxCallsPerQuestion: z.number().int().min(1).max(EVAL_DISCOVERY_CALLS_PER_QUESTION_MAX),
  maxCostMicrosPerQuestion: z.number().int().min(1).max(EVAL_DISCOVERY_COST_PER_QUESTION_MAX_MICROS),
}).strict();
const DraftSchema = z.object({ suites: z.array(DraftSuiteSchema).min(1).max(EVAL_DISCOVERY_SUITES_MAX) }).strict();

export type EvalDiscoveryRefusal = "none" | "unreadable" | "image" | "repository" | "not_found" | "untracked" | "too_large";
/** The fixed words a refusal is told in (the run's live view). */
export const EVAL_DRAFT_REFUSAL_WORDS: Readonly<Record<Exclude<EvalDiscoveryRefusal, "none">, string>> = Object.freeze({
  unreadable: "it was not in the expected form", image: "this worker's image is not pinned", repository: "it names a repository the run did not read",
  not_found: "a file it names is not inside an eval folder Rovara found", untracked: "a file it names is not in the repository", too_large: "it is too large",
});
export type EvalDiscoveryOutcome = { report: SetupEvalDiscoveryReport } | { refused: EvalDiscoveryRefusal };

export interface EvalDiscoveryProducerInput {
  /** The `eval` member of the agent's final proposal answer, as parsed (undefined: the agent drafted no eval). */
  draft: unknown;
  /** The run's repositories: each name and its checkout on the worker. */
  repositories: ReadonlyArray<{ name: string; directory: string }>;
  /** The files tracked at each repository's resolved commit (`trackedPathsOf`). */
  tracked: ReadonlyMap<string, ReadonlySet<string>>;
  /** The worker's own image (`AGENTX_WORKER_IMAGE`). */
  image: string | undefined;
  /** DEC 254zzz43: the setup sandbox's dry-run of each wrapper file, by the suite's selection (`dryRunEvalWrappers`). Absent: no suite carries a pass, so no wrapper is offered. The agent's draft can never carry it (the schema is strict). */
  dryRuns?: ReadonlyMap<string, "passed" | "failed"> | undefined;
  /** F4's discovery of one checkout (test seam; `discoverEvals` in production). */
  discover?: ((root: string) => Promise<EvalDiscovery>) | undefined;
}

/** Whether `path` lies inside one of the suite folders F4 found (`root/...`), or is that file itself. */
const insideFound = (path: string, roots: readonly string[]): boolean => roots.some((root) => path === root || path.startsWith(`${root}/`));

export async function produceEvalDiscoveryReport(input: EvalDiscoveryProducerInput): Promise<EvalDiscoveryOutcome> {
  if (input.draft === undefined || input.draft === null) return { refused: "none" };
  // One total bound on what is read, before any schema walks it.
  let size: number;
  try { size = Buffer.byteLength(JSON.stringify(input.draft) ?? "", "utf8"); } catch { return { refused: "unreadable" }; }
  if (size === 0 || size > EVAL_DISCOVERY_REPORT_MAX_BYTES) return { refused: size === 0 ? "unreadable" : "too_large" };
  const parsed = DraftSchema.safeParse(input.draft);
  if (!parsed.success) return { refused: "unreadable" };
  const image = input.image;
  if (typeof image !== "string" || !EVAL_PINNED_IMAGE.test(image)) return { refused: "image" };

  const discover = input.discover ?? ((root: string) => discoverEvals(root));
  // F4 runs at most once per repository.
  const found = new Map<string, readonly string[]>();
  const rootsOf = async (repository: { name: string; directory: string }): Promise<readonly string[]> => {
    const known = found.get(repository.name);
    if (known !== undefined) return known;
    // F4 failing to read the checkout finds no suite: every question then reads "not found" (never a guess).
    const roots = await discover(repository.directory).then((discovery) => discovery.candidates.map((candidate) => candidate.path), () => [] as string[]);
    found.set(repository.name, roots);
    return roots;
  };

  const suites: SetupEvalDiscoveryReport["suites"] = [];
  for (const draft of parsed.data.suites) {
    const repository = draft.repository === undefined ? (input.repositories.length === 1 ? input.repositories[0] : undefined) : input.repositories.find((entry) => entry.name === draft.repository);
    if (repository === undefined) return { refused: "repository" };
    const tracked = input.tracked.get(repository.name);
    const roots = await rootsOf(repository);
    for (const question of draft.questions) if (!insideFound(question.path, roots)) return { refused: "not_found" };
    // The judge's scoring file belongs to the eval too: a file elsewhere (a manifest, busy source) would make almost every task's eval unprovable.
    if (!insideFound(draft.judge.scoringPath, roots)) return { refused: "not_found" };
    if (tracked === undefined || draft.questions.some((question) => !tracked.has(question.path)) || !tracked.has(draft.judge.scoringPath)) return { refused: "untracked" };
    let commandFingerprint: string;
    try { commandFingerprint = evalCommandFingerprintOf(draft.command, draft.report); } catch { return { refused: "unreadable" }; }
    suites.push({
      selection: draft.selection, ...(draft.repository === undefined ? {} : { repository: draft.repository }),
      questions: [...draft.questions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      command: draft.command, report: draft.report, ...(draft.output === undefined ? {} : { output: draft.output }), ...(input.dryRuns?.get(draft.selection) === undefined ? {} : { wrapperDryRun: input.dryRuns.get(draft.selection)! }), commandFingerprint, judge: draft.judge, subsetSupported: draft.subsetSupported,
      catalogRowId: EVAL_PRODUCT_ROW, model: draft.model, modelVersion: draft.modelVersion, image, route: EVAL_PRODUCT_ROUTE,
      maxCallsPerQuestion: draft.maxCallsPerQuestion, maxCostMicrosPerQuestion: draft.maxCostMicrosPerQuestion,
    });
  }
  suites.sort((a, b) => (a.selection < b.selection ? -1 : a.selection > b.selection ? 1 : 0));
  const report = SetupEvalDiscoveryReportSchema.safeParse({ schemaVersion: 1, suites });
  if (!report.success) return { refused: "unreadable" };
  if (Buffer.byteLength(canonicalJson(report.data), "utf8") > EVAL_DISCOVERY_REPORT_MAX_BYTES) return { refused: "too_large" };
  return { report: report.data };
}
