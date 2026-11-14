import { describe, expect, it } from "vitest";
import { EVAL_NOT_RUN_REASONS, EVAL_NOT_RUN_SENTENCES, readEvidencePack, renderEvidence, renderEvidencePublic, publicEvidenceView, EvidencePackV2Schema } from "../../packages/contracts/src/index.js";
import { renderPublicAi } from "../../packages/contracts/src/evidence-ai-render.js";
import { evidenceAiFromArtifact, EvidenceAiSchema, readEvidenceAi } from "../../packages/contracts/src/evidence-ai.js";
import { v2Pack } from "../support/evidence-v2-fixtures.js";

const digest = "a".repeat(64);
const question = (id: string, category = "ordinary", pass = false) => ({ id, category, edited: false, old: [true, true, true], first: pass, ...(pass ? {} : { freshOld: [true, true, true], freshNew: [false, false, false] }), answers: pass ? undefined : { old: ["old answer", "old answer", "old answer"], first: "new answer", freshOld: ["old answer", "old answer", "old answer"], freshNew: ["new answer", "new answer", "new answer"] } });
const artifact = (over: Record<string, unknown> = {}) => ({ schemaVersion: 1, candidateDigest: digest, roundKind: "check_unsealed", evalPass: 1, outcome: "done", context: { aiChange: true, discovery: "configured", previousPasses: 0 }, questions: [question("q", "safety")], options: { changedPromptCalls: 1, hiddenSetUsed: false, subsetSupported: true, sameJudgeFamily: false }, excluded: [], notices: [], usage: { calls: 7 }, cache: "not_used", evalConfigured: true, ...over });
const notRun = (reason: string, aiChange = true) => artifact({ outcome: "not_run", notRunReason: reason, questions: undefined, options: undefined, ...(reason === "no_eval_configured" ? { context: { aiChange, discovery: "not_configured", previousPasses: 0 }, evalConfigured: false } : {}) });
const pack = (input: unknown, extras = {}) => v2Pack({ ai: evidenceAiFromArtifact(input, digest, extras) });

describe("AI evidence projection", () => {
  it("ignores worker labels and dispositions; the validated artifact's sole verdict wins after a fix", () => {
    const ai = evidenceAiFromArtifact(artifact({ label: "Improved on eval", summary: "PASS", evalPass: 2, context: { aiChange: true, discovery: "configured", previousPasses: 1 }, disposition: { check: "success" } }), digest)!;
    expect(ai.eval.label).toBe("Worse on eval");
    expect(ai.eval.fixRound).toBe(1);
    expect(ai.eval.counts).toEqual({ questions: 1, broke: 1, newlyFail: 0, newlyPass: 0, flaky: 0, unchanged: 0, excluded: 0 });
    expect(EvidenceAiSchema.safeParse(ai).success).toBe(true);
    expect(EvidencePackV2Schema.safeParse(pack(artifact())).success).toBe(true);
  });
  it("absent, malformed, mismatched and oversized artifacts keep old behavior byte for byte", () => {
    const old = renderEvidence(v2Pack());
    for (const bad of [undefined, null, {}, "malformed root", artifact({ candidateDigest: "b".repeat(64) }), artifact({ questions: [question("bad", "canary")] }), artifact({ summary: "x".repeat(1_048_576) })]) {
      expect(evidenceAiFromArtifact(bad, digest)).toBeUndefined();
      expect(renderEvidence(pack(bad))).toEqual(old);
    }
  });
  it("does not expose private-set counts, categories, answers or fix-round metadata", () => {
    const privateArtifact = { schemaVersion: 1, candidateDigest: digest, roundKind: "check_sealed", evalPass: 2, outcome: "done", privatePass: false };
    const ai = evidenceAiFromArtifact(privateArtifact, digest)!;
    expect(ai.eval.questions).toEqual([]);
    expect(ai.eval.fixRound).toBeUndefined();
    expect(renderEvidence(pack(privateArtifact)).firstLine).toBe("Worse on eval on private questions");
    expect(renderEvidence(pack(privateArtifact)).text).not.toContain("0 questions");
  });
  it("prioritizes broken safety questions and keeps every count at the 1,000-question maximum in bounded time", () => {
    const qs = Array.from({ length: 999 }, (_, i) => question(`q${i}`, "ordinary", true)); qs.push(question("safety-last", "safety"));
    const start = performance.now();
    const ai = evidenceAiFromArtifact(artifact({ questions: qs }), digest)!;
    expect(ai.eval.counts!.questions).toBe(1000);
    expect(ai.eval.questions[0]?.id).toBe("safety-last");
    expect(ai.eval.questions.length).toBeLessThanOrEqual(10);
    for (const questionLimit of [10, 5, 2, 0] as const) {
      const out = renderEvidence(v2Pack({ ai }), { questionLimit, compact: questionLimit === 0 });
      expect(out.firstLine).toBe("Worse on eval: 1 question broke");
      expect(out.text).toContain("1000 questions");
      expect(out.text).toContain("safety-last");
      expect(out.text.length).toBeLessThanOrEqual(9000);
    }
    expect(performance.now() - start).toBeLessThan(2000);
  });
  it("cuts and neutralizes hostile excerpts without links, mentions, blocks or credential fragments", () => {
    const hostile = "![x](https://evil.test) [x][ref] @owner #123 <b>bad</b>\n# heading\n> quote\n---\n```\n~~~\n\u202e\ufe0f";
    const q = question(hostile, "safety"); q.answers!.freshNew = [hostile, hostile, hostile];
    const text = renderEvidence(pack(artifact({ questions: [q] }))).text;
    expect(text).toContain("bad");
    expect(text).not.toMatch(/@owner|#123|https:\/\/(?!‍)|!\[|<b>|\u202e|\ufe0f/u);
    expect(text).not.toMatch(/^\s*(?:[#>]|```|~~~)/mu);
    for (const row of evidenceAiFromArtifact(artifact({ questions: [q] }), digest)!.eval.questions) for (const answer of [...row.old, ...row.new]) expect(Array.from(answer).length).toBeLessThanOrEqual(300);
    const large = question("large", "safety"); large.answers!.freshNew = ["x".repeat(1_048_576), "", ""];
    expect(evidenceAiFromArtifact(artifact({ questions: [large] }), digest)).toBeUndefined();
  });
  it("rejects malformed AI sections and real-model inputs with fixed words and no canary", () => {
    for (const realModelRun of [null, { status: "CANARY" }, { status: "ran", passed: 4, total: 3, rerunFailures: 0, trust: "real" }, { status: "ran", passed: 0, total: 0, rerunFailures: 0, trust: "real" }, { status: "ran", passed: NaN, total: 3, rerunFailures: 0, trust: "real" }]) {
      expect(renderEvidence(pack(artifact(), { realModelRun })).text).toContain("Real-model run: Not run (invalid result)");
      expect(renderEvidence(pack(artifact(), { realModelRun })).text).not.toContain("CANARY");
    }
    for (const bad of [{}, { eval: { label: "CANARY" } }, { ...evidenceAiFromArtifact(artifact(), digest), promptWithoutEval: "CANARY" }]) {
      const out = renderEvidence(v2Pack({ ai: bad })).text;
      expect(out).toContain("AI checks: not recorded"); expect(out).not.toContain("CANARY");
      expect(EvidencePackV2Schema.safeParse(v2Pack({ ai: bad })).success).toBe(false);
      const read = readEvidencePack(v2Pack({ ai: bad })); expect(read.status).toBe("v2");
    }
  });
});

describe("AI text goldens", () => {
  it("Worse, unchanged and improved labels are fixed and qualified", () => {
    expect(renderEvidence(pack(artifact())).body.slice(0, 4)).toEqual(["AI checks", "Eval: Worse on eval", "Eval counts: 1 question; 1 broke; 0 newly fail; 0 newly pass; 0 flaky; 0 unchanged; 0 excluded", "Real-model run: Not run (not available yet)"]);
    expect(renderEvidence(pack(artifact({ questions: [question("same", "ordinary", true)] }))).text).toContain("Eval: No drop found");
    const improved = Array.from({ length: 10 }, (_, i) => ({ id: `up${i}`, category: "ordinary", edited: false, old: [false, false, false], first: true, freshOld: [false, false, false], freshNew: [true, true, true] }));
    expect(renderEvidence(pack(artifact({ questions: improved }))).text).toContain("Eval: Improved on eval on questions the agent could read");
  });
  it.each(EVAL_NOT_RUN_REASONS)("Not run %s never becomes a pass", reason => {
    const text = renderEvidence(pack(notRun(reason))).text;
    if (reason === "no_eval_configured") expect(text).toContain("Prompt changed. No eval found, so AI quality wasn't measured.");
    else { expect(text).toContain(EVAL_NOT_RUN_SENTENCES[reason].replace(/^not run: /iu, "")); expect(text).toContain("Retry from the Rovara task page"); }
    expect(text).not.toContain("Eval: No drop found");
  });
  it("DEC 200 requires both AI change and no eval; F10 lines are bounded and inert", () => {
    const notice = "Prompt changed. No eval found, so AI quality wasn't measured. Compare the old and new answers below.";
    expect(renderEvidence(pack(notRun("no_eval_configured"))).text).toContain("Old and new answers: not available yet");
    expect(renderEvidence(pack(notRun("no_eval_configured"), { oldNewLines: ["Old: x", "New: @owner"] })).text).toContain("Old: x");
    expect(renderEvidence(pack(notRun("no_eval_configured", false))).text).not.toContain(notice);
    expect(renderEvidence(pack(notRun("no_product_key"))).text).not.toContain(notice);
    expect(renderEvidence(pack(notRun("no_product_key"))).text).toContain("Eval: Not run: no product AI key is connected");
    expect(evidenceAiFromArtifact(artifact(), digest)!.promptWithoutEval).toBe(false);
    expect(renderEvidence(pack(artifact())).text).not.toContain(notice);
    expect(renderEvidence(pack(artifact())).text).toContain("Eval: Worse on eval");
  });
  it.each([{ status: "ran", passed: 3, total: 3, rerunFailures: 0, trust: "real" }, { status: "ran", passed: 2, total: 3, rerunFailures: 1, trust: "real" }])("real-model run %j stays separate", realModelRun => {
    expect(renderEvidence(pack(artifact(), { realModelRun })).text).toContain(`Real-model run: passed ${realModelRun.passed} of ${realModelRun.total} on the real model; ${realModelRun.rerunFailures} failures re-run`);
  });
  it("public view and text contain only counts and fixed words", () => {
    const q = question("CANARY-ID", "safety"); q.answers!.freshNew = ["CANARY-ANSWER", "CANARY-ANSWER", "CANARY-ANSWER"];
    const p = pack(artifact({ questions: [q] }), { oldNewLines: ["CANARY-F10"] });
    expect(renderEvidence(p).text).toContain("CANARY-ID");
    const out = renderEvidencePublic(p);
    expect(out.firstLine).toBe("Worse on eval: 1 question broke");
    expect(out.text).toContain("Eval counts: 1 question");
    expect(JSON.stringify(publicEvidenceView(p)) + out.text).not.toContain("CANARY");
  });
});

it("records omitted details and rejects over-budget seam inputs as a whole", () => {
  const a = artifact({ questions: Array.from({ length: 12 }, (_, i) => question(`changed${i}`, "safety")) });
  const ai = evidenceAiFromArtifact(a, digest)!;
  expect(ai.eval.questions).toHaveLength(10);
  expect(renderEvidence(v2Pack({ ai })).text).toContain("2 question details not shown");
  for (const oldNewLines of [Array.from({ length: 1001 }, () => "CANARY"), ["CANARY".repeat(200000)], ["safe", 17]]) {
    const out = renderEvidence(pack(notRun("no_eval_configured"), { oldNewLines })).text;
    expect(out).toContain("Old and new answers: not available yet"); expect(out).not.toContain("CANARY");
  }
});

it("keeps the pre-AI ordinary single-repository rendering byte-identical", () => {
  const ordinary = v2Pack({ checks: [], proof: undefined, dependencies: [], meters: undefined, notTested: [] });
  expect(renderEvidence(ordinary).text).toBe("Verified · Real run by Rovara\nChecked in a sealed round\nChecks: none");
  expect(renderEvidence({ ...ordinary, ai: undefined }).text).toBe(renderEvidence(ordinary).text);
  for (const input of [undefined, {}, "malformed root"]) {
    expect(renderEvidence({ ...ordinary, ai: evidenceAiFromArtifact(input, digest) }).text).toBe(renderEvidence(ordinary).text);
    expect(renderEvidencePublic({ ...ordinary, ai: evidenceAiFromArtifact(input, digest) })).toEqual(renderEvidencePublic(ordinary));
  }
});

it("health sensitivity is recorded only when supplied as a valid percentage", () => {
  expect(evidenceAiFromArtifact(artifact(), digest)!.eval.catchableDrop).toBeUndefined();
  expect(renderEvidence(pack(artifact(), { catchableDrop: 20 })).text).toContain("Eval sensitivity: estimated catchable drop 20 points");
  for (const catchableDrop of [NaN, Infinity, -1, 101, "CANARY", null]) {
    expect(evidenceAiFromArtifact(artifact(), digest, { catchableDrop })!.eval.catchableDrop).toBeUndefined();
    expect(renderEvidence(pack(artifact(), { catchableDrop })).text).not.toContain("CANARY");
  }
});

it("reports missing answers and context instead of guessing", () => {
  const q = { ...question("no-answers", "safety"), answers: undefined };
  const out = renderEvidence(pack(artifact({ questions: [q] }))).text;
  expect(out).toContain("Worse on eval"); expect(out).toContain("not recorded");
  expect(evidenceAiFromArtifact(artifact({ context: undefined }), digest)).toBeUndefined();
});

it("accepts maximum Unicode excerpts and bounds their combined rendering", () => {
  const qs = Array.from({ length: 10 }, (_, i) => {
    const q = question(`q${i}`, "safety");
    q.answers!.freshOld = Array.from({ length: 3 }, () => "🧪".repeat(1000));
    q.answers!.freshNew = Array.from({ length: 3 }, () => "🔬".repeat(1000));
    return q;
  });
  const p = pack(artifact({ questions: qs }));
  expect(EvidenceAiSchema.safeParse(p.ai).success).toBe(true);
  expect(renderEvidence(p).text).toContain("Worse on eval");
  expect(renderEvidence(p).text).not.toContain("AI checks: not recorded");
  expect(renderEvidence(p).text.length).toBeLessThanOrEqual(9000);
});

it("validates every stored AI field without exposing a malformed fragment", () => {
  const ai = evidenceAiFromArtifact(artifact(), digest)!;
  const variants = [
    { ...ai, eval: { ...ai.eval, label: "CANARY" } },
    { ...ai, eval: { ...ai.eval, counts: { ...ai.eval.counts, broke: Infinity } } },
    { ...ai, eval: { ...ai.eval, counts: undefined } },
    { ...ai, eval: { ...ai.eval, privateSet: true } },
    { ...ai, eval: { ...ai.eval, notices: ["CANARY"] } },
    { ...ai, eval: { ...ai.eval, questions: [{ ...ai.eval.questions[0], change: "CANARY" }] } },
    { ...ai, realModelRun: { status: "ran", passed: 1, total: 1, rerunFailures: 2, trust: "real" } },
  ];
  for (const bad of variants) {
    expect(EvidenceAiSchema.safeParse(bad).success).toBe(false);
    for (const out of [renderEvidence(v2Pack({ ai: bad })), renderEvidencePublic(v2Pack({ ai: bad }))]) {
      expect(out.text).toContain("AI checks: not recorded"); expect(out.text).not.toContain("CANARY");
    }
    const read = readEvidencePack(v2Pack({ ai: bad }));
    expect(read.status).toBe("v2");
    if (read.status === "v2") expect(renderEvidence(read.pack).text).toContain("AI checks: not recorded");
  }
});

it("neutralizes stored answers at the renderer boundary, including nested and reference markup", () => {
  const ai = evidenceAiFromArtifact(artifact(), digest)!;
  const hostile = "![a[b]c](https://evil.test) [a][ref] @owner #123 <b>CANARY-TEXT</b>\u202e\ufe0f";
  ai.eval.questions[0]!.old = [hostile]; ai.eval.questions[0]!.new = [hostile];
  const out = renderEvidence(v2Pack({ ai })).text;
  expect(out).toContain("CANARY-TEXT"); expect(out).not.toMatch(/@owner|#123|https:\/\/evil|!\[|\[ref\]|<b>|\u202e|\ufe0f/u);
});

it("never drops the AI verdict to fit a full ordinary evidence block", () => {
  const ai = evidenceAiFromArtifact(artifact({ questions: Array.from({ length: 10 }, (_, i) => {
    const q = question(`safety${i}`, "safety"); q.answers!.freshNew = Array.from({ length: 3 }, () => "🧪".repeat(1000)); return q;
  }) }), digest)!;
  const p = v2Pack({ ai, checks: Array.from({ length: 64 }, (_, i) => ({ id: `c${i}`, kind: "test", label: "L".repeat(200), before: "passed", after: "passed", class: "passing", durationMs: 1 })),
    notTested: Array.from({ length: 200 }, () => ({ what: "W".repeat(300), reason: "R".repeat(100) })),
    dependencies: Array.from({ length: 24 }, (_, i) => ({ name: `d${i}${"D".repeat(70)}`, kind: "http", backing: "none", label: "not_available", trust: "simulated" })) });
  const out = renderEvidence(p);
  expect(out.firstLine).toContain("Worse on eval"); expect(out.text).toContain("safety0");
  expect(out.text).toContain("Eval counts: 10 questions"); expect(out.text.length).toBeLessThanOrEqual(9000);
});

it("keeps a broken refusal question ahead of ten earlier flaky details", () => {
  const flaky = Array.from({ length: 10 }, (_, i) => ({ ...question(`flaky${i}`, "ordinary", true), old: [true, false, true] }));
  const ai = evidenceAiFromArtifact(artifact({ questions: [...flaky, question("refusal-last", "refusal")] }), digest)!;
  expect(ai.eval.questions[0]?.id).toBe("refusal-last");
  expect(ai.eval.questions).toHaveLength(10);
  for (const questionLimit of [10, 5, 2, 0] as const) expect(renderEvidence(v2Pack({ ai }), { questionLimit }).text).toContain("refusal-last");
});

it("refuses aggregate F10 input and unknown real-model reasons without partial text", () => {
  const out = renderEvidence(pack(notRun("no_eval_configured"), { oldNewLines: Array.from({ length: 10 }, () => "CANARY".repeat(250)), realModelRun: { status: "not_run", reason: "CANARY" } })).text;
  expect(out).toContain("Old and new answers: not available yet");
  expect(out).toContain("Real-model run: Not run (invalid result)"); expect(out).not.toContain("CANARY");
});

it("refuses exotic payloads before a schema can invoke their accessors", () => {
  let reads = 0;
  const bad = { get eval() { reads++; return { label: "CANARY" }; } };
  expect(readEvidenceAi(bad)).toBeUndefined(); expect(reads).toBe(0);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  const started = performance.now();
  expect(readEvidenceAi(cyclic)).toBeUndefined();
  expect(readEvidenceAi({ pad: "CANARY".repeat(200000) })).toBeUndefined();
  expect(performance.now() - started).toBeLessThan(2000);
});

it("refuses a malformed stored AI flag with fixed words", () => {
  const ai = evidenceAiFromArtifact(artifact(), digest)!;
  const bad = v2Pack({ ai: { ...ai, promptWithoutEval: "CANARY" } });
  expect(renderEvidence(bad).text).toContain("AI checks: not recorded");
  expect(renderEvidencePublic(bad).text).toContain("AI checks: not recorded");
});


it("refuses malformed direct public AI summaries without throwing or echoing input", () => {
  for (const bad of [null, 7, "CANARY", {}, { eval: null }, { eval: { label: "CANARY" } }]) {
    expect(renderPublicAi(bad as never)).toEqual({ lines: ["AI checks: not recorded"] });
  }
});


describe("Round 2 review regressions", () => {
  it.each([true, false])("aggregate-only Worse says what fell, subset %s", subsetSupported => {
    const qs = Array.from({ length: 20 }, (_, i) => ({ ...question(`drop${i}`), freshNew: [true, false, false] }));
    const p = pack(artifact({ questions: qs, options: { changedPromptCalls: 1, hiddenSetUsed: false, subsetSupported, sameJudgeFamily: false } }));
    expect(p.ai!.eval.counts).toMatchObject({ broke: 0, newlyFail: subsetSupported ? 10 : 20, flaky: subsetSupported ? 10 : 0 });
    for (const out of [renderEvidence(p), renderEvidencePublic(p)]) {
      expect(out.firstLine).toBe("Worse on eval: aggregate pass rate dropped");
      expect(out.text).not.toMatch(/\b0 (?:questions? )?broke/u);
    }
  });
  it.each(EVAL_NOT_RUN_REASONS)("Not run %s omits comparison counts and fix rounds in both views", reason => {
    const p = pack(notRun(reason, false));
    const words = `Eval: Not run: ${EVAL_NOT_RUN_SENTENCES[reason].replace(/^not run: /iu, "")}.${reason === "no_eval_configured" ? "" : " Retry from the Rovara task page"}`;
    for (const out of [renderEvidence(p), renderEvidencePublic(p)]) {
      expect(out.body.slice(0, 3)).toEqual(["AI checks", words, "Real-model run: Not run (not available yet)"]);
      expect(out.text).not.toMatch(/Eval counts:|Eval fix round:|0 questions|0 broke/u);
    }
  });
  it("Not run hides stored comparison metadata rather than printing counts or placeholders", () => {
    const ai = evidenceAiFromArtifact(artifact(), digest)!;
    ai.eval.label = "Not run"; ai.eval.notRunReason = "stopped";
    ai.eval.catchableDrop = 10; ai.eval.fixRound = 1;
    ai.eval.counts!.questions = 2; ai.eval.counts!.newlyFail = 1;
    for (const out of [renderEvidence(v2Pack({ ai })), renderEvidencePublic(v2Pack({ ai }))]) {
      expect(out.body.slice(0, 3)).toEqual(["AI checks", "Eval: Not run: the check round stopped before the eval finished. Retry from the Rovara task page", "Real-model run: Not run (not available yet)"]);
      expect(out.text).not.toMatch(/Eval counts:|Eval fix round:|Eval sensitivity:|question details not shown|Old:|New:/u);
    }
  });
  it("DEC 200 points below only when answer lines are actually shown", () => {
    const base = "Eval: Not run. Prompt changed. No eval found, so AI quality wasn't measured.";
    for (const oldNewLines of [undefined, [], ["", "  "], ["Old: CANARY", "New: CANARY"]]) {
      const p = pack(notRun("no_eval_configured"), { oldNewLines });
      const priv = renderEvidence(p); const pub = renderEvidencePublic(p);
      expect(priv.body[1]).toBe(base + ((oldNewLines?.some(line => line.trim().length > 0) ?? false) === false ? "" : " Compare the old and new answers below."));
      expect(pub.body[1]).toBe(base + " Details are behind sign-in.");
      expect(pub.text).not.toMatch(/CANARY|below|Eval counts:|Eval fix round:/u);
      expect(priv.text).not.toMatch(/Eval counts:|Eval fix round:/u);
    }
  });
  it.each([["same  id", "same id"], ["x".repeat(160) + "a", "x".repeat(160) + "b"]])("colliding inert ids never borrow a category (%s)", (a, b) => {
    const ai = evidenceAiFromArtifact(artifact({ questions: [question(a, "safety"), question(b, "ordinary"), question("certain", "refusal")] }), digest)!;
    expect(ai.eval.label).toBe("Worse on eval");
    expect(ai.eval.questions[0]).toMatchObject({ id: "certain", category: "refusal" });
    expect(ai.eval.questions.slice(1).every(q => q.category === undefined)).toBe(true);
    expect(ai.eval.notices).toContain("details_withheld");
  });
  it("one total rendering limit includes the AI headline and full ordinary evidence", () => {
    const long = "🧪".repeat(300);
    const paths = Array.from({ length: 8 }, (_, i) => `${i}${long}`);
    const p = pack(artifact({ questions: Array.from({ length: 10 }, (_, i) => { const q = question(`q${i}`, "safety"); q.answers!.freshNew = [long, long, long]; q.answers!.old = [long, long, long]; return q; }) }));
    p.checks = Array.from({ length: 64 }, (_, i) => ({ ...p.checks[0]!, id: `c${i}`, label: long }));
    p.notTested = Array.from({ length: 10 }, () => ({ what: long, reason: long }));
    p.flags = { instructionFiles: paths, ciExecutedFiles: paths };
    p.weakening = { removedTests: paths, absentOnNew: paths, absentOnNewCount: 8, changedTestConfig: paths, changedSnapshots: paths, changedFixtures: paths, skipRise: { before: 0, after: 10 } };
    p.dependencies = Array.from({ length: 8 }, () => ({ name: long, kind: "http", backing: "none", label: "not_available", trust: "simulated" }));
    for (const compact of [false, true]) {
      const out = renderEvidence(p, { compact, questionLimit: 10, rovaraProblemLine: long, timeTargetLine: long });
      expect(out.text.length).toBeLessThanOrEqual(9000);
      expect(out.text).toContain("Worse on eval: 10 questions broke");
      expect(out.text).toContain("Eval counts: 10 questions");
      expect(out.text).toContain("(safety)");
      expect(out.text).toContain("Rovara instruction files changed");
    }
  });
});
