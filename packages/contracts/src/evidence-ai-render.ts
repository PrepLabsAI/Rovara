// Shared AI words for private and counts-only public evidence. No verdict is decided here.
import { EVAL_NOT_RUN_SENTENCES } from "./eval-check.js";
import { inertEvidenceText } from "./evidence-inert.js";
import { readEvidenceAi, type EvidenceAi, type PublicEvidenceAi } from "./evidence-ai.js";

export const PROMPT_WITHOUT_EVAL_WORDS = "Prompt changed. No eval found, so AI quality wasn't measured. Compare the old and new answers below.";
const realReasons = { not_available: "not available yet", invalid_result: "invalid result", no_product_key: "no product AI key is connected", not_connected: "not connected", stopped: "stopped", provider_error: "provider error" } as const;
const changeWords = { broke: "broke", newly_fail: "newly fail", newly_pass: "newly pass", flaky: "flaky" } as const;
const noticeWords = { details_withheld: "AI question details withheld", baseline_measuring: "baseline still being measured", subset_unsupported: "Question re-asks skipped: the runner cannot run a subset.", same_judge_family: "The judge and product use the same model family." } as const;
const noun = (n: number) => `${n} question${n === 1 ? "" : "s"}`;

function summary(ai: { eval: Pick<EvidenceAi["eval"], "label" | "privateSet" | "counts" | "notRunReason">; realModelRun: EvidenceAi["realModelRun"]; promptWithoutEval: boolean }): { firstLine?: string; lines: string[] } {
  const e = ai.eval; const c = e.counts;
  const firstLine = e.label === "Worse on eval" ? e.privateSet ? "Worse on eval on private questions" : `Worse on eval: ${noun(c!.broke)} broke` : undefined;
  const words = e.privateSet ? `${e.label} on private questions` : e.label === "Improved on eval" ? "Improved on eval on questions the agent could read" : e.label;
  const evalLine = ai.promptWithoutEval ? PROMPT_WITHOUT_EVAL_WORDS : e.label === "Not run" ? `Eval: Not run: ${EVAL_NOT_RUN_SENTENCES[e.notRunReason!].replace(/^not run: /iu, "")}. Retry from the Rovara task page` : `Eval: ${words}`;
  const real = ai.realModelRun;
  return { ...(firstLine === undefined ? {} : { firstLine }), lines: [
    "AI checks", evalLine,
    ...(c === undefined ? [] : [`Eval counts: ${noun(c.questions)}; ${c.broke} broke; ${c.newlyFail} newly fail; ${c.newlyPass} newly pass; ${c.flaky} flaky; ${c.unchanged} unchanged; ${c.excluded} excluded`]),
    real.status === "ran" ? `Real-model run: passed ${real.passed} of ${real.total} on the real model; ${real.rerunFailures} failures re-run` : `Real-model run: Not run (${realReasons[real.reason]})`,
  ] };
}

export function renderPublicAi(input: PublicEvidenceAi | undefined): { firstLine?: string; lines: string[] } {
  if (input === undefined) return { lines: [] };
  if (input === null || typeof input !== "object") return { lines: ["AI checks: not recorded"] };
  // renderPublicView is a public boundary too. Validate, then print only the fixed summary fields.
  const ai = readEvidenceAi({ ...input, eval: { ...input.eval, notices: [], questions: [] } });
  return ai === undefined ? { lines: ["AI checks: not recorded"] } : summary(ai);
}

/** Detail rendering has a total character budget; shrink details, never the verdict or counts. */
export function renderAiEvidence(input: unknown, questionLimit = 10, budget = 4000): { firstLine?: string; lines: string[] } {
  if (input === undefined) return { lines: [] };
  const ai = readEvidenceAi(input);
  if (ai === undefined) return { lines: ["AI checks: not recorded"] };
  const base = summary(ai);
  const e = ai.eval;
  const required = e.questions.find(q => q.change === "broke" && (q.category === "safety" || q.category === "refusal"));
  const detail = (q: EvidenceAi["eval"]["questions"][number]): string[] => [
    `- ${inertEvidenceText(q.id, 100)}: ${changeWords[q.change]}${q.category === undefined ? "" : ` (${q.category})`}`,
    `  Old: ${inertEvidenceText(q.old.filter(Boolean).join(" / ") || "not recorded", 150)}`,
    `  New: ${inertEvidenceText(q.new.filter(Boolean).join(" / ") || "not recorded", 150)}`,
  ];
  const fixed = [...base.lines, ...e.notices.map(n => noticeWords[n]),
    ...(e.catchableDrop === undefined ? [] : [`Eval sensitivity: estimated catchable drop ${e.catchableDrop} points`]),
    ...(e.fixRound === undefined ? [] : [`Eval fix round: ${e.fixRound}`]),
  ];
  const requested = [0, 2, 5, 10].includes(questionLimit) ? questionLimit : 10;
  const qs = e.questions.slice(0, requested);
  if (required !== undefined && !qs.includes(required)) qs.unshift(required);
  const changed = e.counts === undefined ? 0 : e.counts.broke + e.counts.newlyFail + e.counts.newlyPass + e.counts.flaky;
  const linesFor = () => [...fixed, ...qs.flatMap(detail), ...(changed > qs.length ? [`${changed - qs.length} question details not shown`] : [])];
  let lines = linesFor();
  while (lines.join("\n").length > budget && qs.length > (required === undefined ? 0 : 1)) {
    const index = qs.findLastIndex(q => q !== required); qs.splice(index, 1); lines = linesFor();
  }
  if (ai.promptWithoutEval) {
    const pairs = ai.oldNewLines?.map(s => inertEvidenceText(s, 300));
    lines.push(...(pairs !== undefined && pairs.length > 0 && [...lines, ...pairs].join("\n").length <= budget ? pairs : ["Old and new answers: not available yet"]));
  }
  return { ...base, lines };
}
