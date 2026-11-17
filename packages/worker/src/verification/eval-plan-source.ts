// DEC 253j(1): the worker's side of the TRUSTED eval plan. The broker delivers the stored plan (bound to an approved eval spend item) through the signed `eval-plan` callback; the
// per-task parts are the worker's own, computed here from the check's PINNED candidate (the commit-and-tree identities the CHECKS round already read), never from the sandbox or the
// repository's word:
//   baseCommit   the repository's base commit, which the pinned candidate must name too, and which must equal the base the broker filled in from the run's own pin
//   codeHash     `evalCodeHash(baseCommit)`, equal to the broker's
//   questions    each question file's content hash (`evalQuestionHash`) at the base commit and in the candidate tree. The BASE hash must equal the hash stored at setup: a question
//                that moved, vanished or changed on the base since the plan was approved makes the whole plan not runnable. A head hash that differs marks that question "edited".
// Anything that does not hold (no pinned candidate, another repository layout, a base that is not the broker's, a file over the bounds, an unreadable object) is no plan: the eval
// reads "not connected" and spends nothing. A question file changed on the base since approval reads its own reason ("questions changed since setup approval: re-approve").
import { AsyncLocalStorage } from "node:async_hooks";
import {
  EVAL_QUESTION_FILE_MAX_BYTES, EVAL_QUESTION_FILES_TOTAL_MAX_BYTES, EVAL_QUESTION_LIMIT, EVAL_QUESTION_REMOVED_HASH, EvalPlanBodyShape, evalCodeHash, evalPlanCommandHolds, evalQuestionHash,
  type EvalCommand, type EvalReportPath,
} from "@agentx/contracts";
import { z } from "zod";
import { withIsolatedGit } from "../isolated-git.js";
import type { CandidateRepositoryIdentity, CandidateRepositoryInput } from "./candidate.js";
import { EVAL_PLAN_QUESTIONS_CHANGED, type EvalFinalCheckPlan } from "./eval-final-check.js";

/** DEC 253n(2): the CHECKS round's own facts the fresh check sandbox is built from (never the plan's or the sandbox's word). */
export interface EvalCheckRound {
  /** The working sandbox's container (paused while the base side runs), or null when the task has none. */
  readonly workingSandbox: string | null;
  /** What is left of the round's budget when the eval starts (milliseconds). */
  readonly roundBudgetMs: number;
  /** An absolute folder of the worker's own for this eval (checkouts, env files, report copies); the round removes it when the eval is over. */
  readonly scratchDir: string;
}
interface Pin { readonly repositories: readonly CandidateRepositoryInput[]; readonly candidates: readonly CandidateRepositoryIdentity[]; readonly signal: AbortSignal; readonly round?: EvalCheckRound | undefined }
const pins = new AsyncLocalStorage<Pin>();
const objectId = /^[a-f0-9]{40}$/u;
const hash = z.string().regex(/^[a-f0-9]{64}$/u);

/** Runs `run` with this check's pinned candidate as the source of the eval plan's per-task hashes (and, with `round`, of the fresh check sandbox). Concurrent checks (and companies) never see each other's pin. */
export function withEvalPinnedCandidate<T>(repositories: readonly CandidateRepositoryInput[], candidates: readonly CandidateRepositoryIdentity[], signal: AbortSignal, run: () => Promise<T>, round?: EvalCheckRound): Promise<T> {
  return pins.run(Object.freeze({ repositories: [...repositories], candidates: candidates.map(candidate => Object.freeze({ ...candidate })), signal, ...(round === undefined ? {} : { round: Object.freeze({ ...round }) }) }), run);
}

/** True while a pinned candidate is in force (inside `withEvalPinnedCandidate`). The worker-verification test uses it to pin WHERE the shared plan read happens. */
export function evalPinnedCandidateActive(): boolean { return pins.getStore() !== undefined; }

/** The plan as the broker delivers it: the stored body, its company and project, its digest, and the key with the run's base. */
const DeliveredPlanSchema = EvalPlanBodyShape.omit({ key: true }).extend({
  company: z.string().min(1).max(100), project: z.string().min(1).max(200), planDigest: hash,
  key: z.object({
    company: z.string().min(1).max(100), project: z.string().min(1).max(200), baseCommit: z.string().regex(objectId), codeHash: hash, judgePin: hash,
    commandFingerprint: hash, catalogRowId: z.string(), model: z.string(), modelVersion: z.string(),
  }).strict(),
}).strict();

type Side = Map<string, string | undefined>;

/** Each path's content hash at `treeish` (undefined where the path is not a file there). Throws for anything over the bounds or unreadable. */
async function hashesAt(directory: string, treeishes: readonly string[], paths: readonly string[], signal: AbortSignal): Promise<Side[]> {
  return await withIsolatedGit(directory, "read", async (git) => {
    const options = { index: "none" as const, signal, timeout: 30_000 };
    // Each side's commit or tree must itself be here: a missing object is unreadable (no plan), never "every question file is missing".
    const present = await git.text(["cat-file", "--batch-check=%(objecttype)"], { ...options, input: `${treeishes.join("\n")}\n`, maxBuffer: 64 * 1024 });
    const types = present.split("\n");
    if (types.pop() !== "" || types.length !== treeishes.length || types.some(type => type !== "commit" && type !== "tree")) throw new Error("unreadable listing");
    const asked = treeishes.flatMap(treeish => paths.map(path => `${treeish}:${path}`));
    const listing = await git.text(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], { ...options, input: `${asked.join("\n")}\n`, maxBuffer: 1024 * 1024 });
    const lines = listing.split("\n");
    if (lines.pop() !== "" || lines.length !== asked.length) throw new Error("unreadable listing");
    const sides = treeishes.map(() => new Map<string, { oid: string; size: number } | undefined>());
    const wanted = new Map<string, number>();
    let total = 0;
    lines.forEach((line, index) => {
      const side = sides[Math.floor(index / paths.length)]!; const path = paths[index % paths.length]!;
      const match = /^([a-f0-9]{40}) (blob|tree|commit|tag) (\d{1,12})$/u.exec(line);
      if (match === null) {
        if (line !== `${asked[index]} missing`) throw new Error("unreadable listing");
        side.set(path, undefined); return;
      }
      if (match[2] !== "blob") { side.set(path, undefined); return; }
      const size = Number(match[3]);
      if (!Number.isSafeInteger(size) || size > EVAL_QUESTION_FILE_MAX_BYTES) throw new Error("question file too large");
      if (!wanted.has(match[1]!)) { total += size; wanted.set(match[1]!, size); }
      if (total > EVAL_QUESTION_FILES_TOTAL_MAX_BYTES) throw new Error("question files too large");
      side.set(path, { oid: match[1]!, size });
    });
    const hashes = new Map<string, string>();
    if (wanted.size > 0) {
      const oids = [...wanted.keys()];
      const raw = await git.bytes(["cat-file", "--batch"], { ...options, input: `${oids.join("\n")}\n`, maxBuffer: total + oids.length * 64 + 1024 });
      let at = 0;
      for (const oid of oids) {
        const end = raw.indexOf(0x0a, at);
        if (end < 0 || raw.subarray(at, end).toString("utf8") !== `${oid} blob ${wanted.get(oid)!}`) throw new Error("unreadable object");
        const start = end + 1; const stop = start + wanted.get(oid)!;
        if (stop >= raw.length || raw[stop] !== 0x0a) throw new Error("unreadable object");
        hashes.set(oid, evalQuestionHash(raw.subarray(start, stop)));
        at = stop + 1;
      }
      if (at !== raw.length) throw new Error("unreadable object");
    }
    return sides.map(side => new Map([...side].map(([path, found]) => [path, found === undefined ? undefined : hashes.get(found.oid)])));
  });
}

/**
 * The final-check plan for THIS check, from the broker's delivered plan and the pinned candidate, or undefined (not runnable). Never throws. Called inside `withEvalPinnedCandidate`.
 * A plan that is otherwise this run's (its scope, repository, base and key all hold) but whose question file on the base no longer holds the approved question answers
 * `EVAL_PLAN_QUESTIONS_CHANGED` (EVAL-PLAN-STALE-REASON): the eval reads "questions changed since setup approval: re-approve", with zero calls.
 */
type DeliveredPlan = z.infer<typeof DeliveredPlanSchema>;
interface PinnedCheck { readonly pin: Pin; readonly plan: DeliveredPlan; readonly repository: CandidateRepositoryInput; readonly candidate: CandidateRepositoryIdentity; readonly base: string; readonly codeHash: string }

/** The delivered plan read against THIS check's pin: its shape, its scope, its stored command hash (DEC 253n(2)), its repository, the pinned candidate and the base the broker filled in. Undefined for anything that does not hold. */
function pinnedCheck(delivered: unknown): PinnedCheck | undefined {
  const pin = pins.getStore();
  if (pin === undefined || pin.signal.aborted) return undefined;
  if (typeof delivered !== "object" || delivered === null || !Array.isArray((delivered as { questions?: unknown }).questions) || (delivered as { questions: unknown[] }).questions.length > EVAL_QUESTION_LIMIT) return undefined;
  const parsed = DeliveredPlanSchema.safeParse(delivered);
  if (!parsed.success) return undefined;
  const plan = parsed.data;
  if (new Set(plan.questions.map(q => q.id)).size !== plan.questions.length || plan.company !== plan.key.company || plan.project !== plan.key.project || plan.key.judgePin !== plan.judgePin) return undefined;
  // The command and report path, when the plan has them, must be exactly what its stored command hash covers.
  if (!evalPlanCommandHolds(plan)) return undefined;
  // The repository that holds the eval: the plan's named one, else the check's only one.
  const repository = plan.repository === undefined ? (pin.repositories.length === 1 ? pin.repositories[0] : undefined) : pin.repositories.find(entry => entry.repositoryId === plan.repository);
  if (repository === undefined) return undefined;
  const candidate = pin.candidates.find(entry => entry.repositoryId === repository.repositoryId);
  const base = repository.baseCommitSha;
  if (candidate === undefined || base === undefined || !objectId.test(base) || candidate.baseCommitSha !== base || !objectId.test(candidate.treeSha)) return undefined;
  // The per-task key parts are the worker's own; the broker's (from the run's pinned base) must be the same.
  const codeHash = evalCodeHash(base);
  if (plan.key.baseCommit !== base || plan.key.codeHash !== codeHash) return undefined;
  return { pin, plan, repository, candidate, base, codeHash };
}

/** DEC 253n(2): what the fresh check sandbox is built from for THIS check: the plan's confirmed command and report path (held to its stored command hash), its model row, model and image, the pinned candidate's two commits and the round's own facts. Undefined: no fresh sandbox (the eval reads Not run). Never throws. */
export interface EvalFreshCheck {
  readonly command: EvalCommand;
  readonly report: EvalReportPath;
  readonly rowId: string;
  readonly model: string;
  readonly imageDigest: string;
  /** The candidate's commit runs on the new side; `candidateTree` is the tree the plan's head hashes were read from, which that commit's own tree must be (checked before it runs). */
  readonly repository: { readonly directory: string; readonly baseCommit: string; readonly candidateCommit: string; readonly candidateTree: string };
  readonly round: EvalCheckRound;
}
export function pinnedEvalFreshCheck(delivered: unknown): EvalFreshCheck | undefined {
  try {
    const found = pinnedCheck(delivered);
    if (found === undefined || found.pin.round === undefined || found.plan.command === undefined || found.plan.report === undefined) return undefined;
    if (!objectId.test(found.candidate.commitSha)) return undefined;
    return {
      command: found.plan.command, report: found.plan.report, rowId: found.plan.key.catalogRowId, model: found.plan.key.model, imageDigest: found.plan.settings.imageDigest,
      repository: { directory: found.repository.directory, baseCommit: found.base, candidateCommit: found.candidate.commitSha, candidateTree: found.candidate.treeSha }, round: found.pin.round,
    };
  } catch { return undefined; }
}

export async function pinnedEvalPlan(delivered: unknown): Promise<EvalFinalCheckPlan | typeof EVAL_PLAN_QUESTIONS_CHANGED | undefined> {
  try {
    const found = pinnedCheck(delivered);
    if (found === undefined) return undefined;
    const { pin, plan, repository, candidate, base, codeHash } = found;
    const paths = [...new Set(plan.questions.map(q => q.path))];
    const [atBase, atHead] = paths.length === 0 ? [new Map(), new Map()] as Side[] : await hashesAt(repository.directory, [base, candidate.treeSha], paths, pin.signal);
    if (atBase === undefined || atHead === undefined || pin.signal.aborted) return undefined;
    const questions: EvalFinalCheckPlan["questions"][number][] = [];
    for (const question of plan.questions) {
      const baseHash = atBase.get(question.path);
      // The base must hold exactly the question the approved plan was made from.
      if (baseHash === undefined || baseHash !== question.hash) return EVAL_PLAN_QUESTIONS_CHANGED;
      questions.push({ id: question.id, category: question.category, baseHash, headHash: atHead.get(question.path) ?? EVAL_QUESTION_REMOVED_HASH });
    }
    return {
      company: plan.company, project: plan.project, selection: plan.selection, inputs: plan.inputs,
      key: { company: plan.key.company, project: plan.key.project, baseCommit: base, codeHash, judgePin: plan.judgePin, commandFingerprint: plan.key.commandFingerprint, catalogRowId: plan.key.catalogRowId, model: plan.key.model, modelVersion: plan.key.modelVersion },
      settings: plan.settings, evalSetHash: plan.evalSetHash, evalConfigured: plan.evalConfigured, judgePin: plan.judgePin, baselineJudgePin: plan.baselineJudgePin,
      ...(plan.sameJudgeFamily === undefined ? {} : { sameJudgeFamily: plan.sameJudgeFamily }), subsetSupported: plan.subsetSupported,
      questions, maxCallsPerQuestion: plan.maxCallsPerQuestion, maxCostMicrosPerQuestion: plan.maxCostMicrosPerQuestion,
    };
  } catch { return undefined; }
}
