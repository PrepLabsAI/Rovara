// DEC 253j(1): the worker's side of the TRUSTED eval plan. The broker delivers the stored plan (bound to an approved eval spend item) through the signed `eval-plan` callback; the
// per-task parts are the worker's own, computed here from the check's PINNED candidate (the commit-and-tree identities the CHECKS round already read), never from the sandbox or the
// repository's word:
//   baseCommit   the repository's base commit, which the pinned candidate must name too, and which must equal the base the broker filled in from the run's own pin
//   codeHash     `evalCodeHash(baseCommit)`, equal to the broker's
//   questions    each question file's content hash (`evalQuestionHash`) at the base commit and in the candidate tree. The BASE hash must equal the hash stored at setup: a question
//                that moved, vanished or changed on the base since the plan was approved makes the whole plan not runnable. A head hash that differs marks that question "edited".
// Anything that does not hold (no pinned candidate, another repository layout, a base that is not the broker's, a file over the bounds, an unreadable object) is no plan: the eval
// reads "not connected" and spends nothing.
import { AsyncLocalStorage } from "node:async_hooks";
import {
  EVAL_QUESTION_FILE_MAX_BYTES, EVAL_QUESTION_FILES_TOTAL_MAX_BYTES, EVAL_QUESTION_LIMIT, EVAL_QUESTION_REMOVED_HASH, EvalPlanBodyShape, evalCodeHash, evalQuestionHash,
} from "@agentx/contracts";
import { z } from "zod";
import { withIsolatedGit } from "../isolated-git.js";
import type { CandidateRepositoryIdentity, CandidateRepositoryInput } from "./candidate.js";
import type { EvalFinalCheckPlan } from "./eval-final-check.js";

interface Pin { readonly repositories: readonly CandidateRepositoryInput[]; readonly candidates: readonly CandidateRepositoryIdentity[]; readonly signal: AbortSignal }
const pins = new AsyncLocalStorage<Pin>();
const objectId = /^[a-f0-9]{40}$/u;
const hash = z.string().regex(/^[a-f0-9]{64}$/u);

/** Runs `run` with this check's pinned candidate as the source of the eval plan's per-task hashes. Concurrent checks (and companies) never see each other's pin. */
export function withEvalPinnedCandidate<T>(repositories: readonly CandidateRepositoryInput[], candidates: readonly CandidateRepositoryIdentity[], signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  return pins.run(Object.freeze({ repositories: [...repositories], candidates: candidates.map(candidate => Object.freeze({ ...candidate })), signal }), run);
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
 */
export async function pinnedEvalPlan(delivered: unknown): Promise<EvalFinalCheckPlan | undefined> {
  try {
    const pin = pins.getStore();
    if (pin === undefined || pin.signal.aborted) return undefined;
    if (typeof delivered !== "object" || delivered === null || !Array.isArray((delivered as { questions?: unknown }).questions) || (delivered as { questions: unknown[] }).questions.length > EVAL_QUESTION_LIMIT) return undefined;
    const parsed = DeliveredPlanSchema.safeParse(delivered);
    if (!parsed.success) return undefined;
    const plan = parsed.data;
    if (new Set(plan.questions.map(q => q.id)).size !== plan.questions.length || plan.company !== plan.key.company || plan.project !== plan.key.project || plan.key.judgePin !== plan.judgePin) return undefined;
    // The repository that holds the eval: the plan's named one, else the check's only one.
    const repository = plan.repository === undefined ? (pin.repositories.length === 1 ? pin.repositories[0] : undefined) : pin.repositories.find(entry => entry.repositoryId === plan.repository);
    if (repository === undefined) return undefined;
    const candidate = pin.candidates.find(entry => entry.repositoryId === repository.repositoryId);
    const base = repository.baseCommitSha;
    if (candidate === undefined || base === undefined || !objectId.test(base) || candidate.baseCommitSha !== base || !objectId.test(candidate.treeSha)) return undefined;
    // The per-task key parts are the worker's own; the broker's (from the run's pinned base) must be the same.
    const codeHash = evalCodeHash(base);
    if (plan.key.baseCommit !== base || plan.key.codeHash !== codeHash) return undefined;
    const paths = [...new Set(plan.questions.map(q => q.path))];
    const [atBase, atHead] = paths.length === 0 ? [new Map(), new Map()] as Side[] : await hashesAt(repository.directory, [base, candidate.treeSha], paths, pin.signal);
    if (atBase === undefined || atHead === undefined || pin.signal.aborted) return undefined;
    const questions: EvalFinalCheckPlan["questions"][number][] = [];
    for (const question of plan.questions) {
      const baseHash = atBase.get(question.path);
      // The base must hold exactly the question the approved plan was made from.
      if (baseHash === undefined || baseHash !== question.hash) return undefined;
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
