// DEC 253j(1): the worker completes the broker's stored eval plan with its OWN per-task hashes from the pinned candidate (real git repositories), and refuses a plan whose base does
// not hold exactly the questions the approved plan names. Every guard has a test that fails without it.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EVAL_QUESTION_FILE_MAX_BYTES, EVAL_QUESTION_REMOVED_HASH, evalCodeHash, evalCommandFingerprint, evalQuestionHash } from "@agentx/contracts";
import { pinnedEvalPlan, withEvalPinnedCandidate } from "../../packages/worker/src/verification/eval-plan-source.js";
import { EVAL_PLAN_QUESTIONS_CHANGED, type EvalFinalCheckPlan } from "../../packages/worker/src/verification/eval-final-check.js";
import { evalSettingsFingerprint } from "../../packages/worker/src/verification/eval-round.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))); });
const g = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
async function repo(base: Record<string, string | Buffer>, head: Record<string, string | Buffer | null>, id = "web") {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "eps-"))); roots.push(dir);
  g(dir, "init", "-q");
  for (const [p, c] of Object.entries(base)) { await mkdir(dirname(join(dir, p)), { recursive: true }); await writeFile(join(dir, p), c); }
  g(dir, "add", "-A"); g(dir, "commit", "-qm", "base"); const baseSha = g(dir, "rev-parse", "HEAD");
  for (const [p, c] of Object.entries(head)) { if (c === null) await rm(join(dir, p)); else { await mkdir(dirname(join(dir, p)), { recursive: true }); await writeFile(join(dir, p), c); } }
  g(dir, "add", "-A"); g(dir, "commit", "-qm", "head", "--allow-empty"); const tree = g(dir, "rev-parse", "HEAD^{tree}");
  return { repositories: [{ repositoryId: id, directory: dir, baseCommitSha: baseSha }], candidates: [{ repositoryId: id, commitSha: g(dir, "rev-parse", "HEAD"), treeSha: tree, baseCommitSha: baseSha }], dir, baseSha, tree };
}
const sig = () => new AbortController().signal;
const A = "org_aaaaaaaaaaaaaaaaaaaa";
const settings = { imageDigest: "sha256:" + "e".repeat(64), route: "gateway" };
const judgePin = "b".repeat(64);
const inputs = { evalSetHash: "a".repeat(64), judgePin, modelVersion: "version-1", model: "model", catalogRowId: "model", commandFingerprint: evalCommandFingerprint("npm run eval"), settingsFingerprint: evalSettingsFingerprint(settings, judgePin) };
const Q1 = "question one\n"; const Q2 = "question two\n";
/** What the broker delivers: the stored body, its scope and digest, and the key with the run's pinned base. */
const delivered = (baseCommit: string, over: Record<string, unknown> = {}, keyOver: Record<string, unknown> = {}) => ({
  company: A, project: "demo", planDigest: "f".repeat(64), selection: "evals/demo", inputs, settings, evalSetHash: inputs.evalSetHash, evalConfigured: true, judgePin, baselineJudgePin: judgePin, subsetSupported: true,
  questions: [{ id: "q1", category: "ordinary", path: "evals/demo/q1.txt", hash: evalQuestionHash(Buffer.from(Q1)) }, { id: "q2", category: "safety", path: "evals/demo/q2.txt", hash: evalQuestionHash(Buffer.from(Q2)) }],
  maxCallsPerQuestion: 2, maxCostMicrosPerQuestion: 10,
  key: { company: A, project: "demo", baseCommit, codeHash: evalCodeHash(baseCommit), judgePin, commandFingerprint: inputs.commandFingerprint, catalogRowId: "model", model: "model", modelVersion: "version-1", ...keyOver },
  ...over,
});
type Repo = Awaited<ReturnType<typeof repo>>;
const inPin = (r: Pick<Repo, "repositories" | "candidates">, plan: unknown, signal = sig()) => withEvalPinnedCandidate(r.repositories, r.candidates, signal, () => pinnedEvalPlan(plan));
/** A runnable plan only (the stale answer is not one). */
const planIn = async (r: Pick<Repo, "repositories" | "candidates">, plan: unknown): Promise<EvalFinalCheckPlan | undefined> => { const found = await inPin(r, plan); return found === undefined || found === EVAL_PLAN_QUESTIONS_CHANGED || "notRun" in found ? undefined : found; };

describe("the worker's per-task eval plan from the pinned candidate", () => {
  it("happy path: computes the base commit, the code hash and each question's base and head hash; an edited question reads edited, a removed one too", async () => {
    const r = await repo({ "evals/demo/q1.txt": Q1, "evals/demo/q2.txt": Q2, "src/app.ts": "a\n" }, { "evals/demo/q2.txt": "question two, edited\n", "src/app.ts": "b\n" });
    const plan = await planIn(r, delivered(r.baseSha));
    expect(plan).toEqual({
      company: A, project: "demo", selection: "evals/demo", inputs, settings, evalSetHash: inputs.evalSetHash, evalConfigured: true, judgePin, baselineJudgePin: judgePin, subsetSupported: true, maxCallsPerQuestion: 2, maxCostMicrosPerQuestion: 10,
      key: { company: A, project: "demo", baseCommit: r.baseSha, codeHash: evalCodeHash(r.baseSha), judgePin, commandFingerprint: inputs.commandFingerprint, catalogRowId: "model", model: "model", modelVersion: "version-1" },
      questions: [
        { id: "q1", category: "ordinary", baseHash: evalQuestionHash(Buffer.from(Q1)), headHash: evalQuestionHash(Buffer.from(Q1)) },
        { id: "q2", category: "safety", baseHash: evalQuestionHash(Buffer.from(Q2)), headHash: evalQuestionHash(Buffer.from("question two, edited\n")) },
      ],
    });
    const removed = await repo({ "evals/demo/q1.txt": Q1, "evals/demo/q2.txt": Q2 }, { "evals/demo/q2.txt": null });
    expect((await planIn(removed, delivered(removed.baseSha)))?.questions[1]).toEqual({ id: "q2", category: "safety", baseHash: evalQuestionHash(Buffer.from(Q2)), headHash: EVAL_QUESTION_REMOVED_HASH });
  });

  it("a base that does not hold the approved question is not runnable and says so: changed, missing, or a folder read \"questions changed\" (mutants: the base hash check, the missing-base check, the stale reason)", async () => {
    const changed = await repo({ "evals/demo/q1.txt": "something else\n", "evals/demo/q2.txt": Q2 }, {});
    expect(await inPin(changed, delivered(changed.baseSha))).toBe(EVAL_PLAN_QUESTIONS_CHANGED);
    const missing = await repo({ "evals/demo/q2.txt": Q2 }, { "evals/demo/q1.txt": Q1 });
    expect(await inPin(missing, delivered(missing.baseSha))).toBe(EVAL_PLAN_QUESTIONS_CHANGED);
    const folder = await repo({ "evals/demo/q1.txt/inner": Q1, "evals/demo/q2.txt": Q2 }, {});
    expect(await inPin(folder, delivered(folder.baseSha))).toBe(EVAL_PLAN_QUESTIONS_CHANGED);
    // Only a question change on the base reads so: the same stale base under another run's key is still no plan (the key checks come first).
    expect(await inPin(changed, delivered(changed.baseSha, {}, { baseCommit: "d".repeat(40) }))).toBeUndefined();
    // A base commit that is not in the checkout is unreadable (no plan), never "questions changed" (review L2).
    const absent = "d".repeat(40);
    const shallow = { repositories: [{ ...changed.repositories[0]!, baseCommitSha: absent }], candidates: [{ ...changed.candidates[0]!, baseCommitSha: absent }] };
    expect(await inPin(shallow, delivered(absent))).toBeUndefined();
    // A question the CANDIDATE edits is not stale: it is that run's change.
    const edited = await repo({ "evals/demo/q1.txt": Q1, "evals/demo/q2.txt": Q2 }, { "evals/demo/q1.txt": "edited on the branch\n" });
    expect(await inPin(edited, delivered(edited.baseSha))).toMatchObject({ questions: [{ id: "q1" }, { id: "q2" }] });
  });

  it("the broker's base must be the pinned candidate's: another base commit, another code hash or another judge pin in the key is not runnable (mutants: each key check)", async () => {
    const r = await repo({ "evals/demo/q1.txt": Q1, "evals/demo/q2.txt": Q2 }, {});
    const other = "c".repeat(40);
    expect(await inPin(r, delivered(other))).toBeUndefined();
    expect(await inPin(r, delivered(r.baseSha, {}, { codeHash: evalCodeHash(other) }))).toBeUndefined();
    expect(await inPin(r, delivered(r.baseSha, {}, { baseCommit: other }))).toBeUndefined();
    expect(await inPin(r, delivered(r.baseSha, {}, { judgePin: "d".repeat(64) }))).toBeUndefined();
    // The candidate must name the same base as its repository.
    expect(await inPin({ repositories: r.repositories, candidates: [{ ...r.candidates[0]!, baseCommitSha: other }] }, delivered(r.baseSha))).toBeUndefined();
    expect(await inPin(r, delivered(r.baseSha))).toBeDefined();
  });

  it("outside a pinned check, for another scope or shape, it is no plan (mutants: the pin, the company/project match, the strict shape, unique ids)", async () => {
    const r = await repo({ "evals/demo/q1.txt": Q1, "evals/demo/q2.txt": Q2 }, {});
    expect(await pinnedEvalPlan(delivered(r.baseSha))).toBeUndefined();
    expect(await inPin(r, delivered(r.baseSha, { company: "org_bbbbbbbbbbbbbbbbbbbb" }))).toBeUndefined();
    expect(await inPin(r, delivered(r.baseSha, { project: "other" }))).toBeUndefined();
    expect(await inPin(r, { ...delivered(r.baseSha), extra: true })).toBeUndefined();
    const plan = delivered(r.baseSha);
    expect(await inPin(r, { ...plan, questions: [plan.questions[0], { ...plan.questions[1], id: "q1" }] })).toBeUndefined();
    expect(await inPin(r, { ...plan, questions: [{ ...plan.questions[0], path: "../outside.txt" }] })).toBeUndefined();
    expect(await inPin(r, { ...plan, questions: [{ ...plan.questions[0], path: "evals/demo/q1.txt\nHEAD:x" }] })).toBeUndefined();
    const aborted = new AbortController(); aborted.abort();
    expect(await inPin(r, plan, aborted.signal)).toBeUndefined();
    expect(await inPin(r, { ...plan, questions: [] }, aborted.signal)).toBeUndefined();
    expect(await inPin(r, { ...plan, questions: [] })).toBeDefined();
    expect(await inPin(r, null)).toBeUndefined();
  });

  it("chooses the plan's own repository; with several and none named it is not runnable (mutant: the single-repository rule)", async () => {
    const one = await repo({ "evals/demo/q1.txt": Q1, "evals/demo/q2.txt": Q2 }, {}, "web");
    const two = await repo({ "evals/demo/q1.txt": "not this\n" }, {}, "api");
    const both = { repositories: [...two.repositories, ...one.repositories], candidates: [...two.candidates, ...one.candidates] };
    expect(await inPin(both, delivered(one.baseSha))).toBeUndefined();
    expect((await planIn(both, delivered(one.baseSha, { repository: "web" })))?.key.baseCommit).toBe(one.baseSha);
    expect(await inPin(both, delivered(one.baseSha, { repository: "nowhere" }))).toBeUndefined();
    // Two repositories pinned at the same base: still not runnable when the plan names none.
    const twin = { repositories: [{ ...one.repositories[0]!, repositoryId: "twin" }, ...one.repositories], candidates: [{ ...one.candidates[0]!, repositoryId: "twin" }, ...one.candidates] };
    expect(await inPin(twin, delivered(one.baseSha))).toBeUndefined();
  });

  it("is bounded: a question file over the per-file limit is not runnable, and many questions sharing files are read once each", async () => {
    const big = Buffer.alloc(EVAL_QUESTION_FILE_MAX_BYTES + 1, 0x61);
    const r = await repo({ "evals/demo/q1.txt": big, "evals/demo/q2.txt": Q2 }, {});
    const plan = delivered(r.baseSha);
    expect(await inPin(r, { ...plan, questions: [{ ...plan.questions[0], hash: evalQuestionHash(big) }, plan.questions[1]] })).toBeUndefined();
    const shared = await repo({ "evals/demo/all.jsonl": Q1 }, {});
    const questions = Array.from({ length: 1000 }, (_, i) => ({ id: `q${i}`, category: "ordinary", path: "evals/demo/all.jsonl", hash: evalQuestionHash(Buffer.from(Q1)) }));
    const started = Date.now();
    const many = await planIn(shared, delivered(shared.baseSha, { questions }));
    expect(many?.questions).toHaveLength(1000);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await inPin(shared, delivered(shared.baseSha, { questions: [...questions, { ...questions[0]!, id: "q1000" }] }))).toBeUndefined();
  });

  it("concurrent checks never see each other's pin", async () => {
    const a = await repo({ "evals/demo/q1.txt": Q1, "evals/demo/q2.txt": Q2 }, {});
    const b = await repo({ "evals/demo/q1.txt": Q1, "evals/demo/q2.txt": Q2 }, { "evals/demo/q1.txt": "b edit\n" });
    const [pa, pb] = await Promise.all([planIn(a, delivered(a.baseSha)), planIn(b, delivered(b.baseSha))]);
    expect(pa?.key.baseCommit).toBe(a.baseSha); expect(pb?.key.baseCommit).toBe(b.baseSha);
    expect(pa?.questions[0]?.headHash).toBe(evalQuestionHash(Buffer.from(Q1)));
    expect(pb?.questions[0]?.headHash).toBe(evalQuestionHash(Buffer.from("b edit\n")));
  });
});
