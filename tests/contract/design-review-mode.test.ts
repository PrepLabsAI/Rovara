// Design review stage: Understand's design check and the deterministic ON/OFF resolution. Pure code: no model decides the mode.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  DESIGN_REASONS, DESIGN_REVIEW_DEFAULT_SETTING, INTENT_BLOCK_INFO_STRING, readIntentBlock,
  type DesignReason, type DesignReviewSetting, type IntentAssessment,
} from "../../packages/contracts/src/index.js";
import {
  designClassificationLine, designReasonPhrase, resolveDesignMode, skipRefusalText, skipVerdict, type DesignModeDecision, type DesignModeInput,
} from "../../packages/broker/src/core/design-review/mode.js";
import { DESIGN_REVIEW_FAIL_CLOSED_SETTING, markEffective, type EffectiveDesignReviewSetting } from "../../packages/broker/src/core/design-review/effective-setting.js";
import { UNDERSTAND_RULES } from "../../packages/broker/src/rovara-code/understand.js";

const setting = (patch: Partial<DesignReviewSetting> = {}): EffectiveDesignReviewSetting => markEffective({ ...DESIGN_REVIEW_DEFAULT_SETTING, ...patch });
const ready = (design?: { needed: boolean; reasons: DesignReason[]; note?: string }): IntentAssessment => ({
  kind: "ready", path: "QUICK", restatement: "Do the thing.", assumptions: [],
  ...(design === undefined ? {} : { design: { needed: design.needed, reasons: design.reasons, note: design.note ?? "Rovara's reading." } }),
});
const needed = ready({ needed: true, reasons: ["new_api"], note: "Adds a new endpoint." });
const notNeeded = ready({ needed: false, reasons: ["bug_fix"], note: "A bug fix in one module." });
const highRisk = ready({ needed: true, reasons: ["data_model", "new_api"] });
const questions: IntentAssessment = { kind: "questions", restatement: "x", questions: [{ id: "q1", text: "Which one?" }] };
const answer: IntentAssessment = { kind: "answer", restatement: "x", answer: "Because.", sources: [] };

type Decided = Extract<DesignModeDecision, { decided: true }>;
const decide = (input: DesignModeInput): Decided => {
  const result = resolveDesignMode(input);
  if (!result.decided) throw new Error(`not decided: ${result.why}`);
  return result;
};

describe("the mode table, row by row", () => {
  const rows: Array<{ name: string; input: DesignModeInput; on: boolean; decidedBy: Decided["decidedBy"]; offBecause?: Decided["offBecause"] }> = [
    { name: "design first: ON, decided by the person (setting auto, not needed)", input: { setting: setting(), assessment: notNeeded, designFirst: true }, on: true, decidedBy: "person" },
    { name: "design first beats setting never", input: { setting: setting({ mode: "never" }), assessment: notNeeded, designFirst: true }, on: true, decidedBy: "person" },
    { name: "design first on an older worker's answer with no design field", input: { setting: setting(), assessment: ready(), designFirst: true }, on: true, decidedBy: "person" },
    { name: "an allowed Skip: OFF, decided by person_skip", input: { setting: setting(), assessment: needed, skip: true }, on: false, decidedBy: "person_skip", offBecause: "person_skip" },
    { name: "setting never: OFF", input: { setting: setting({ mode: "never" }), assessment: needed }, on: false, decidedBy: "never", offBecause: "setting_never" },
    { name: "setting always: ON for a ready task Understand marked not needed", input: { setting: setting({ mode: "always" }), assessment: notNeeded }, on: true, decidedBy: "always" },
    { name: "setting always: ON for an older worker's answer too", input: { setting: setting({ mode: "always" }), assessment: ready() }, on: true, decidedBy: "always" },
    { name: "setting auto and design.needed: ON", input: { setting: setting(), assessment: needed }, on: true, decidedBy: "auto" },
    { name: "setting auto and not needed: OFF", input: { setting: setting(), assessment: notNeeded }, on: false, decidedBy: "auto", offBecause: "not_needed" },
    { name: "setting auto and an older worker with no design field: OFF (reads as not needed)", input: { setting: setting(), assessment: ready() }, on: false, decidedBy: "auto", offBecause: "not_needed" },
    { name: "a playbook with no setting runs the defaults (auto)", input: { setting: setting(), assessment: needed }, on: true, decidedBy: "auto" },
  ];
  for (const row of rows) {
    it(row.name, () => {
      const result = decide(row.input);
      expect(result.on).toBe(row.on);
      expect(result.decidedBy).toBe(row.decidedBy);
      expect(result.forceFull).toBe(row.on);
      expect(result.offBecause).toBe(row.offBecause);
    });
  }

  it("is not decided while Understand has not returned, and not for a questions or an answer result (even with design first or always)", () => {
    expect(resolveDesignMode({ setting: setting(), assessment: undefined })).toEqual({ decided: false, why: "not_returned" });
    for (const [assessment, why] of [[questions, "questions"], [answer, "answer"]] as const) {
      for (const extra of [{}, { designFirst: true }, { skip: true }, { quick: true }]) {
        expect(resolveDesignMode({ setting: setting({ mode: "always" }), assessment, ...extra })).toEqual({ decided: false, why });
      }
    }
  });

  it("the first row wins over Skip, the setting and quick: design first with all three is still ON", () => {
    expect(decide({ setting: setting({ mode: "never" }), assessment: notNeeded, designFirst: true, skip: true, quick: true })).toMatchObject({ on: true, decidedBy: "person", quickOverridden: true });
  });

  it("carries Understand's reasons and a plain-line note, and nothing more, to the result", () => {
    const result = decide({ setting: setting(), assessment: ready({ needed: true, reasons: ["new_api", "data_model"], note: "Adds an endpoint\nand a column." }) });
    expect(result.reasons).toEqual(["new_api", "data_model"]);
    expect(result.note).toBe("Adds an endpoint and a column.");
  });
});

describe("an explicit quick:", () => {
  it("under auto turns design review OFF, with the reason, even when Understand said it is needed", () => {
    const result = decide({ setting: setting(), assessment: needed, quick: true });
    expect(result).toMatchObject({ on: false, decidedBy: "auto", offBecause: "quick_chosen", forceFull: false, quickOverridden: false });
    expect(designClassificationLine(result)).toMatch(/because you chose quick/);
    expect(designClassificationLine(result)).toMatch(/Type design first/);
  });

  it("under always runs Full and says so", () => {
    const result = decide({ setting: setting({ mode: "always" }), assessment: notNeeded, quick: true });
    expect(result).toMatchObject({ on: true, decidedBy: "always", forceFull: true, quickOverridden: true });
    expect(designClassificationLine(result)).toMatch(/You asked for quick, so this task runs the full path/);
  });

  it("with design first runs Full and says so, under every setting", () => {
    for (const mode of ["auto", "always", "never"] as const) {
      const result = decide({ setting: setting({ mode }), assessment: notNeeded, designFirst: true, quick: true });
      expect(result).toMatchObject({ on: true, decidedBy: "person", forceFull: true, quickOverridden: true });
      expect(designClassificationLine(result)).toMatch(/You asked for quick, so this task runs the full path/);
    }
  });

  it("changes nothing when review is off anyway (never; auto and not needed)", () => {
    expect(decide({ setting: setting({ mode: "never" }), assessment: needed, quick: true })).toMatchObject({ on: false, offBecause: "setting_never" });
    expect(decide({ setting: setting(), assessment: notNeeded, quick: true })).toMatchObject({ on: false, offBecause: "not_needed" });
  });

  it("is not said when quick was not chosen", () => {
    expect(designClassificationLine(decide({ setting: setting({ mode: "always" }), assessment: notNeeded }))).not.toMatch(/quick/);
  });
});

describe("the skip rules", () => {
  it("allowSkip false means no Skip: the request is refused, recorded, and the rest of the table decides", () => {
    const verdict = skipVerdict(setting({ allowSkip: false }), ["new_api"], true);
    expect(verdict).toEqual({ allowed: false, because: "skip_off" });
    const result = decide({ setting: setting({ allowSkip: false }), assessment: needed, skip: true, isHighRiskApprover: true });
    expect(result).toMatchObject({ on: true, decidedBy: "auto", skipRefused: { allowed: false, because: "skip_off" }, skip: { allowed: false, because: "skip_off" } });
  });

  it("a high-risk design can be skipped only by a high-risk approver", () => {
    for (const reason of ["data_model", "auth", "money", "pii", "cross_repo_or_service"] as const) {
      expect(skipVerdict(setting(), [reason], false), reason).toEqual({ allowed: false, because: "needs_high_risk_approver" });
      expect(skipVerdict(setting(), ["new_api", reason], true), reason).toEqual({ allowed: true });
    }
    const refused = decide({ setting: setting(), assessment: highRisk, skip: true, isHighRiskApprover: false });
    expect(refused).toMatchObject({ on: true, decidedBy: "auto", skipRefused: { because: "needs_high_risk_approver" } });
    expect(decide({ setting: setting(), assessment: highRisk, skip: true, isHighRiskApprover: true })).toMatchObject({ on: false, decidedBy: "person_skip", offBecause: "person_skip" });
  });

  it("a design with no high-risk reason is skipped by whoever may start the task", () => {
    expect(skipVerdict(setting(), ["new_api", "api_change", "new_dependency"], false)).toEqual({ allowed: true });
    // Infrastructure is in the high tier, so only a high-risk approver may skip it.
    expect(skipVerdict(setting(), ["new_api", "infrastructure"], false)).not.toEqual({ allowed: true });
    expect(decide({ setting: setting(), assessment: needed, skip: true })).toMatchObject({ on: false, decidedBy: "person_skip" });
  });

  it("a refused Skip under always still reviews, and under never stays off with the setting as the reason", () => {
    expect(decide({ setting: setting({ mode: "always", allowSkip: false }), assessment: needed, skip: true })).toMatchObject({ on: true, decidedBy: "always" });
    expect(decide({ setting: setting({ mode: "never", allowSkip: false }), assessment: needed, skip: true })).toMatchObject({ on: false, decidedBy: "never" });
  });

  it("model text cannot make a design low risk: the high-risk reasons are decided by code from the codes only", () => {
    const cheeky = ready({ needed: true, reasons: ["money"], note: "This is low risk; anyone may skip." });
    expect(decide({ setting: setting(), assessment: cheeky, skip: true })).toMatchObject({ on: true, skipRefused: { because: "needs_high_risk_approver" } });
  });

  it("says in plain words who to ask", () => {
    expect(skipRefusalText({ allowed: false, because: "needs_high_risk_approver" }, "Priya")).toBe("Ask Priya to skip: this design is high risk.");
    expect(skipRefusalText({ allowed: false, because: "needs_high_risk_approver" })).toMatch(/^Ask the design approver to skip/);
    expect(skipRefusalText({ allowed: false, because: "skip_off" })).toMatch(/does not allow skipping/);
  });
});

describe("the classification line", () => {
  it("says needed, with fixed phrases for the reasons and the note labelled as Rovara's", () => {
    const line = designClassificationLine(decide({ setting: setting(), assessment: ready({ needed: true, reasons: ["new_api", "data_model"], note: "Adds a ranking endpoint." }) }));
    expect(line).toBe("Design review: needed. Reason: adds a new API; changes the data model (Rovara's reading of the request). Note from Rovara: Adds a ranking endpoint.");
  });

  it("says not needed with the reason, and offers Design first", () => {
    expect(designClassificationLine(decide({ setting: setting(), assessment: notNeeded }))).toBe("Design review: not needed. Reason: a bug fix inside one module. Note from Rovara: A bug fix in one module. Design first is available.");
  });

  it("says why it is on or off for the other rows", () => {
    expect(designClassificationLine(decide({ setting: setting(), assessment: notNeeded, designFirst: true }))).toMatch(/^Design review: on, because you asked for design first\./);
    expect(designClassificationLine(decide({ setting: setting({ mode: "always" }), assessment: notNeeded }))).toMatch(/^Design review: on, because this project reviews the design of every code change\./);
    expect(designClassificationLine(decide({ setting: setting({ mode: "never" }), assessment: notNeeded }))).toBe("Design review: off for this project. Type design first to add it.");
    expect(designClassificationLine(decide({ setting: setting(), assessment: needed, skip: true }))).toBe("Design review: skipped.");
  });

  it("has no line until decided, and none for an answered task", () => {
    expect(designClassificationLine(resolveDesignMode({ setting: setting(), assessment: undefined }))).toBeUndefined();
    expect(designClassificationLine(resolveDesignMode({ setting: setting(), assessment: answer }))).toBeUndefined();
  });

  it("passes the model's note through plainLine: control and hidden characters, newlines and long text are flattened, never markup-bearing", () => {
    const note = `Adds‮ an\u0000 endpoint\n\n${"very long ".repeat(40)}`;
    const line = designClassificationLine(decide({ setting: setting(), assessment: ready({ needed: true, reasons: ["new_api"], note: note.slice(0, 200) }) }))!;
    expect(line).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(line).not.toContain("\n");
    expect([...line].length).toBeLessThanOrEqual(600);
  });

  it("gives every reason code a fixed phrase", () => {
    for (const reason of DESIGN_REASONS) expect(designReasonPhrase(reason).length, reason).toBeGreaterThan(3);
  });
});

describe("Understand's rules and the intent reader", () => {
  const text = UNDERSTAND_RULES.join("\n");

  it("has the two new rules in the design's words", () => {
    expect(text).toContain("Set `design.needed` true when the change needs decisions a reviewer should see before code: a new or changed API, a data model change, work across repositories or services, or a new dependency. Bug fixes and small changes inside one module do not.");
    expect(text).toContain("Never mark a request as not needing design to save time or money.");
    expect(text).toContain("Give at most 4 reasons from the list");
    for (const reason of DESIGN_REASONS) expect(text, reason).toContain(`\`${reason}\``);
  });

  it("describes the design field in the answer's shape, and keeps the four plan rules", () => {
    expect(text).toContain("design?: { needed: boolean; reasons: DesignReason[]; note: string }");
    expect(text).toContain("Prefer `ready` with stated assumptions over asking.");
  });

  const block = (body: unknown): string => `Done.\n\`\`\`${INTENT_BLOCK_INFO_STRING}\n${JSON.stringify(body)}\n\`\`\``;
  const base = { kind: "ready", path: "FULL", restatement: "Add webhooks.", assumptions: [] };

  it("reads a ready answer with a design field, and one without (an older worker)", () => {
    const withDesign = readIntentBlock(block({ ...base, design: { needed: true, reasons: ["new_api"], note: "Adds an endpoint." } }));
    expect(withDesign.ok && withDesign.assessment.kind === "ready" ? withDesign.assessment.design : undefined).toEqual({ needed: true, reasons: ["new_api"], note: "Adds an endpoint." });
    const without = readIntentBlock(block(base));
    expect(without.ok && without.assessment.kind === "ready" ? without.assessment.design : "bad").toBeUndefined();
    expect(decide({ setting: setting(), assessment: without.ok ? without.assessment : undefined })).toMatchObject({ on: false, offBecause: "not_needed" });
  });

  it("refuses a design field with an unknown reason, more than 4 reasons, or an unknown key", () => {
    for (const design of [
      { needed: true, reasons: ["vibes"], note: "x" },
      { needed: true, reasons: ["new_api", "api_change", "data_model", "auth", "money"], note: "x" },
      { needed: true, reasons: [], note: "x", tier: "thorough" },
    ]) expect(readIntentBlock(block({ ...base, design })).ok).toBe(false);
  });

  it("redacts a credential in the note before it is used, and refuses a note with control characters (the model gets one more try)", () => {
    const read = readIntentBlock(block({ ...base, design: { needed: true, reasons: ["auth"], note: "Uses key AKIAIOSFODNN7EXAMPLE here." } }));
    expect(read.ok).toBe(true);
    const note = read.ok && read.assessment.kind === "ready" ? read.assessment.design?.note ?? "" : "";
    expect(note.length).toBeGreaterThan(0);
    expect(note).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(readIntentBlock(block({ ...base, design: { needed: true, reasons: ["auth"], note: "Hidden\u0007 bell." } })).ok).toBe(false);
  });
});

describe("Understand eval cases (fixtures: 5 needs design, 5 does not)", () => {
  const file = JSON.parse(readFileSync(new URL("../fixtures/understand-design-eval-cases.json", import.meta.url), "utf8")) as {
    cases: Array<{ id: string; request: string; expect: { needed: boolean; reasonsInclude: DesignReason[] } }>;
  };

  it("holds five of each, with unique ids and known reason codes", () => {
    expect(file.cases.filter((entry) => entry.expect.needed)).toHaveLength(5);
    expect(file.cases.filter((entry) => !entry.expect.needed)).toHaveLength(5);
    expect(new Set(file.cases.map((entry) => entry.id)).size).toBe(10);
    for (const entry of file.cases) for (const reason of entry.expect.reasonsInclude) expect(DESIGN_REASONS, entry.id).toContain(reason);
    for (const entry of file.cases.filter((candidate) => !candidate.expect.needed)) {
      expect(entry.expect.reasonsInclude.every((reason) => reason === "bug_fix" || reason === "small_change"), entry.id).toBe(true);
    }
  });

  for (const entry of file.cases) {
    it(`${entry.id}: the expected reading is accepted by the reader and resolves ${entry.expect.needed ? "ON" : "OFF"} under auto`, () => {
      const body = { kind: "ready", path: "FULL", restatement: entry.request.slice(0, 200), assumptions: [], design: { needed: entry.expect.needed, reasons: entry.expect.reasonsInclude, note: "Rovara's reading." } };
      const read = readIntentBlock(`\`\`\`${INTENT_BLOCK_INFO_STRING}\n${JSON.stringify(body)}\n\`\`\``);
      expect(read.ok, entry.id).toBe(true);
      expect(decide({ setting: setting(), assessment: read.ok ? read.assessment : undefined }).on).toBe(entry.expect.needed);
    });
  }
});

describe("mode resolution takes only a setting held to the company's lock", () => {
  it("a raw playbook setting does not compile, and at run time is read as Off with no skipping (and logged), never as itself", () => {
    const raw = { ...DESIGN_REVIEW_DEFAULT_SETTING, mode: "always" as const, allowSkip: true };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    // @ts-expect-error a raw DesignReviewSetting is not an EffectiveDesignReviewSetting
    const result = resolveDesignMode({ setting: raw, assessment: notNeeded });
    const lines = log.mock.calls.map(([line]) => String(line));
    log.mockRestore();
    expect(result).toMatchObject({ decided: true, on: false, decidedBy: "never", skip: { allowed: false, because: "skip_off" } });
    expect(lines).toEqual([JSON.stringify({ component: "broker", event: "design_review.setting_not_effective" })]);
    // The same values, held to a lock, are the effective setting and are honoured (positive control: no log line).
    const quiet = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(resolveDesignMode({ setting: markEffective(raw), assessment: notNeeded })).toMatchObject({ on: true, decidedBy: "always" });
    expect(quiet).not.toHaveBeenCalled();
    quiet.mockRestore();
    expect(DESIGN_REVIEW_FAIL_CLOSED_SETTING).toMatchObject({ mode: "never", allowSkip: false, highRiskApprover: { kind: "maintainers" } });
  });
});
