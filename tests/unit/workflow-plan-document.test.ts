// Structured plan documents: the planner's `agentx-plan` block, read all at once with plain-English errors.
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment -- the tests edit parsed JSON drafts into invalid shapes */
import { describe, expect, it } from "vitest";
import {
  PLAN_CLAIMS_MAX, PLAN_DECISIONS_MAX, WORKFLOW_BLOCK_REASONS, WorkflowArtifactSchema, canonicalPlanJson, diffPlanDocuments, lastFencedBlock, parsePlanDocument,
  planClaimCount, planClaimIds, planDocumentMarkdown, planSummaryLines, readCanonicalPlan, retiredClaimIds, type PlanDocument, type WorkflowCheck,
} from "@agentx/contracts";
import { planAnswer, planDocument, type RawChecksInput } from "../support/plan-documents.js";

const UNREADABLE = "AgentX could not read the proposed checks";
const required: WorkflowCheck[] = [
  { id: "required-1", label: "npm test", command: { cwd: "workspace/payments", executable: "npm", args: ["test"], timeoutSeconds: 120 } },
];
const codingInput = { kind: "plan" as const, checks: { repositoryPaths: ["workspace/payments"], required } };
const rawCheck = (overrides: Record<string, unknown> = {}) => ({
  label: "Retry tests", cwd: "workspace/payments", executable: "npx", args: ["vitest", "run", "tests/retry.test.ts"], proves: ["1"], ...overrides,
});

/** The planner's answer for a hand-edited document, bypassing the typed helper so invalid shapes can be written. */
function answerOf(mutate: (plan: Record<string, any>) => void, extraChecks?: unknown): string {
  const plan = JSON.parse(JSON.stringify(planDocument())) as Record<string, any>;
  mutate(plan);
  if (extraChecks !== undefined) plan["checks"] = extraChecks;
  return `Plan below.\n\n\`\`\`agentx-plan\n${JSON.stringify(plan)}\n\`\`\`\n`;
}
const errorsOf = (answer: string, kind: "requirements" | "design" | "plan" = "design", retired?: ReadonlySet<string>): string[] => {
  const result = parsePlanDocument(answer, { kind, ...(retired === undefined ? {} : { retiredClaimIds: retired }) });
  if (result.ok) throw new Error("expected the plan to be refused");
  return result.errors;
};
const claim = (id: string, children?: unknown[]) => ({ id, text: `Claim ${id}.`, ...(children === undefined ? {} : { children }) });

describe("parsePlanDocument", () => {
  it("reads a valid answer, ignoring the prose around the fence", () => {
    const plan = planDocument();
    const result = parsePlanDocument(`Thinking out loud.\n\n${planAnswer(plan)}\nAnything else?`, { kind: "design" });
    expect(result).toEqual({ ok: true, plan });
  });

  it("uses the last agentx-plan fence and ignores fences with another info string", () => {
    const first = planDocument({ title: "First" });
    const second = planDocument({ title: "Second" });
    const other = `\`\`\`json\n${JSON.stringify(planDocument({ title: "Other" }))}\n\`\`\`\n`;
    const result = parsePlanDocument(`${planAnswer(first)}\n${planAnswer(second)}\n${other}`, { kind: "design" });
    expect(result.ok && result.plan.title).toBe("Second");
  });

  it("explains an answer with no block, an unclosed block and invalid JSON", () => {
    expect(errorsOf("Just words.")).toEqual([expect.stringContaining("Your answer has no agentx-plan block")]);
    expect(errorsOf("```agentx-plan\n{\"schemaVersion\":1")).toEqual([expect.stringContaining("not closed")]);
    expect(errorsOf("```agentx-plan\n{nope\n```")).toEqual([expect.stringContaining("not valid JSON")]);
    expect(errorsOf("```agentx-plan\n[1]\n```")).toEqual([expect.stringContaining("one JSON object")]);
  });

  it("refuses an unknown property, naming it", () => {
    const errors = errorsOf(answerOf((plan) => { plan["claims"][1]["colour"] = "red"; }));
    expect(errors).toEqual([expect.stringMatching(/claim 2: .*unknown property "colour"/)]);
    expect(errorsOf(answerOf((plan) => { plan["mood"] = 1; }))).toEqual([expect.stringMatching(/the plan: .*unknown property "mood"/)]);
  });

  it("names a claim in a field error", () => {
    const errors = errorsOf(answerOf((plan) => { plan["claims"][0]["children"][0]["text"] = "x".repeat(301); }));
    expect(errors).toEqual(["claim 1.1: text is too long (at most 300 characters)"]);
  });

  it("refuses a duplicate claim ID", () => {
    expect(errorsOf(answerOf((plan) => { plan["claims"][1]["id"] = "1"; }))).toEqual([expect.stringMatching(/claim 1: .*more than once/)]);
  });

  it("refuses a sub-claim whose parent is not there, and one placed under the wrong parent", () => {
    expect(errorsOf(answerOf((plan) => { plan["claims"].push(claim("3.1")); })))
      .toEqual([expect.stringMatching(/claim 3\.1: .*top level.*claim 3/)]);
    expect(errorsOf(answerOf((plan) => { plan["claims"][0]["children"].push(claim("2.1")); })))
      .toEqual([expect.stringMatching(/claim 2\.1: .*placed under claim 1/)]);
  });

  it("refuses claims nested four deep", () => {
    const errors = errorsOf(answerOf((plan) => { plan["claims"][0]["children"][0]["children"] = [claim("1.1.1", [claim("1.1.1.1")])]; }));
    expect(errors).toEqual([expect.stringMatching(/nest more than 3 levels/)]);
    expect(parsePlanDocument(answerOf((plan) => { plan["claims"][0]["children"][0]["children"] = [claim("1.1.1")]; }), { kind: "design" }).ok).toBe(true);
  });

  it("allows 50 claims and refuses 51", () => {
    const claims = (count: number) => Array.from({ length: count }, (_, index) => claim(String(index + 1)));
    expect(PLAN_CLAIMS_MAX).toBe(50);
    expect(parsePlanDocument(answerOf((plan) => { plan["claims"] = claims(50); plan["decisions"] = []; }), { kind: "design" }).ok).toBe(true);
    expect(errorsOf(answerOf((plan) => { plan["claims"] = claims(51); plan["decisions"] = []; })))
      .toEqual([expect.stringMatching(/51 claims; at most 50/)]);
  });

  it("allows 20 decisions and refuses 21", () => {
    const decisions = (count: number) => Array.from({ length: count }, (_, index) => ({
      id: `d${index + 1}`, claimId: "2", question: "Which way?",
      options: [{ id: "a", label: "A", consequence: "Faster." }, { id: "b", label: "B", consequence: "Safer." }], recommended: "a",
    }));
    expect(PLAN_DECISIONS_MAX).toBe(20);
    expect(parsePlanDocument(answerOf((plan) => { plan["decisions"] = decisions(20); }), { kind: "design" }).ok).toBe(true);
    expect(errorsOf(answerOf((plan) => { plan["decisions"] = decisions(21); })))
      .toEqual([expect.stringMatching(/decisions has too many items \(at most 20\)/)]);
  });

  it("refuses a decision about a missing claim, a recommendation that is not an option, and a single option", () => {
    expect(errorsOf(answerOf((plan) => { plan["decisions"][0]["claimId"] = "9"; }))).toEqual([expect.stringMatching(/decision d1: .*claim 9/)]);
    expect(errorsOf(answerOf((plan) => { plan["decisions"][0]["recommended"] = "ten"; }))).toEqual([expect.stringMatching(/decision d1: .*recommended option "ten"/)]);
    expect(errorsOf(answerOf((plan) => { plan["decisions"][0]["options"].pop(); }))).toEqual([expect.stringMatching(/decision d1: options needs at least 2 items/)]);
  });

  it("refuses evidence that points at something it did not declare", () => {
    const flow = { kind: "flow", participants: ["App", "Bank"], steps: [{ from: "App", to: "Bank", label: "charge" }, { from: "Bank", to: "Ledger", label: "post" }] };
    expect(errorsOf(answerOf((plan) => { plan["claims"][1]["evidence"] = [flow]; })))
      .toEqual([expect.stringMatching(/claim 2: evidence 1 steps 2 to names "Ledger", who is not one of the participants/)]);
    const machine = { kind: "stateMachine", states: ["open", "closed"], initial: "paused", transitions: [{ from: "open", to: "closed", label: "close" }] };
    expect(errorsOf(answerOf((plan) => { plan["claims"][1]["evidence"] = [machine]; })))
      .toEqual([expect.stringMatching(/claim 2: evidence 1 initial names "paused", which is not one of the states/)]);
    const schema = { kind: "schema", entities: [{ name: "Order", fields: [{ name: "id", type: "uuid" }] }], relations: [{ from: "Order", to: "Customer", label: "placed by" }] };
    expect(errorsOf(answerOf((plan) => { plan["claims"][1]["evidence"] = [schema]; })))
      .toEqual([expect.stringMatching(/claim 2: evidence 1 relations 1 to names "Customer", which is not one of the entities/)]);
  });

  it("accepts each kind of evidence", () => {
    const evidence = [
      { kind: "code", path: "repo/app/src/a.ts", startLine: 1, endLine: 3 },
      { kind: "sketch", language: "ts", code: "const retry = true;", note: "New." },
      { kind: "flow", participants: ["App", "Bank"], steps: [{ from: "App", to: "Bank", label: "charge" }] },
    ];
    const more = [
      { kind: "schema", entities: [{ name: "Order", fields: [{ name: "id", type: "uuid" }] }], relations: [] },
      { kind: "stateMachine", states: ["open", "closed"], initial: "open", transitions: [{ from: "open", to: "closed", label: "close" }] },
      { kind: "quote", text: "Please retry.", author: "Priya" },
    ];
    expect(parsePlanDocument(answerOf((plan) => { plan["claims"][0]["evidence"] = evidence; plan["claims"][1]["evidence"] = more; }), { kind: "design" }).ok).toBe(true);
  });

  it("accepts a code citation's anchor line up to 300 characters, keeps it in the stored plan, and refuses one with a control character other than a tab", () => {
    const cite = (anchor: unknown) => answerOf((plan) => { plan["claims"][0]["evidence"] = [{ kind: "code", path: "repo/app/src/a.ts", startLine: 1, endLine: 3, anchor }]; });
    const read = parsePlanDocument(cite("## License"), { kind: "design" });
    expect(read.ok && read.plan.claims[0]!.evidence).toEqual([{ kind: "code", path: "repo/app/src/a.ts", startLine: 1, endLine: 3, anchor: "## License" }]);
    expect(parsePlanDocument(cite("x".repeat(300)), { kind: "design" }).ok).toBe(true);
    expect(errorsOf(cite("x".repeat(301)))).toEqual([expect.stringMatching(/claim 1: evidence 1 anchor is too long \(at most 300 characters\)/)]);
    expect(errorsOf(cite(""))).toEqual([expect.stringMatching(/claim 1: evidence 1 anchor is empty/)]);
    // A line from a tab-indented file must be quotable.
    const tabbed = parsePlanDocument(cite("\treturn name;\t"), { kind: "design" });
    expect(tabbed.ok && tabbed.plan.claims[0]!.evidence).toEqual([{ kind: "code", path: "repo/app/src/a.ts", startLine: 1, endLine: 3, anchor: "\treturn name;\t" }]);
    for (const bad of ["one\ntwo", "a\rb", "a\u0007b", "a\u007fb", "a\u0000b"]) {
      expect(errorsOf(cite(bad))).toEqual([expect.stringMatching(/claim 1: evidence 1 anchor may not contain line breaks or control characters/)]);
    }
    const stored = planDocument({ claims: [{ id: "1", text: "A.", evidence: [{ kind: "code", path: "repo/app/src/a.ts", startLine: 1, endLine: 3, anchor: "## License" }] }] });
    expect(readCanonicalPlan(canonicalPlanJson(stored))).toEqual(stored);
  });

  it("refuses a claim ID that an earlier version retired", () => {
    expect(errorsOf(answerOf(() => undefined), "design", new Set(["2"]))).toEqual([expect.stringMatching(/claim 2: .*earlier version removed/)]);
  });

  it("refuses checks on a requirements or design document, and accepts them on a coding plan", () => {
    const withChecks = answerOf(() => undefined, { checks: [rawCheck()] });
    expect(errorsOf(withChecks, "requirements")).toEqual([expect.stringMatching(/checks belong only in the coding plan/)]);
    expect(errorsOf(withChecks, "design")).toEqual([expect.stringMatching(/checks belong only in the coding plan/)]);
    expect(parsePlanDocument(withChecks, { kind: "plan" }).ok).toBe(true);
  });

  it("without a checks input, only requires a coding plan's checks member to be an object, and leaves it out", () => {
    const result = parsePlanDocument(answerOf(() => undefined, { checks: [rawCheck({ cwd: "elsewhere/x" })] }), { kind: "plan" });
    expect(result).toEqual({ ok: true, plan: planDocument() });
    expect(errorsOf(answerOf(() => undefined, "nope"), "plan")).toEqual([expect.stringMatching(/checks should be an object/)]);
    expect(errorsOf(answerOf(() => undefined, [1]), "plan")).toEqual([expect.stringMatching(/checks should be an object/)]);
  });

  it("caps the errors at 20, each in plain English and naming the entry", () => {
    const errors = errorsOf(answerOf((plan) => {
      plan["claims"] = Array.from({ length: 30 }, (_, index) => ({ id: String(index + 1), text: "" }));
    }));
    expect(errors).toHaveLength(20);
    expect(errors[0]).toBe("claim 1: text is empty");
    expect(errors.at(-1)).toMatch(/^and \d+ more problems$/);
    for (const error of errors) expect(error.length).toBeLessThanOrEqual(200);
  });

  it("names an unknown property once, and never repeats more than 60 characters of it", () => {
    const errors = errorsOf(answerOf((plan) => { plan["claims"][1][`a${"x".repeat(80)}`] = 1; plan["claims"][1]["b"] = 2; }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/and 1 more/);
    expect(errors[0]).not.toContain("x".repeat(61));
  });

  it("reports a value of the wrong type as the wrong type, and an absent one as missing", () => {
    expect(errorsOf(answerOf((plan) => { plan["claims"][0]["text"] = 5; }))).toEqual(["claim 1: text should be text"]);
    expect(errorsOf(answerOf((plan) => { plan["claims"][0]["evidence"] = "none"; }))).toEqual(["claim 1: evidence should be a list"]);
    expect(errorsOf(answerOf((plan) => { plan["title"] = 7; }))).toEqual(["the plan: title should be text"]);
    expect(errorsOf(answerOf((plan) => { delete plan["claims"][0]["text"]; }))).toEqual(["claim 1: text is missing"]);
  });

  it("holds claim IDs to at most three numbers of at most three digits", () => {
    expect(errorsOf(answerOf((plan) => { plan["claims"][1]["id"] = "1000"; plan["decisions"] = []; })))
      .toEqual(["claim 1000: id should be a number like 1, 1.1 or 1.1.1"]);
    expect(parsePlanDocument(answerOf((plan) => { plan["claims"][1]["id"] = "999"; plan["decisions"] = []; }), { kind: "design" }).ok).toBe(true);
    expect(errorsOf(answerOf((plan) => { plan["claims"][1]["id"] = "02"; plan["decisions"] = []; }))).toEqual([expect.stringContaining("id should be a number like")]);
  });

  it("holds decisions to the d1, d2 form, 2 to 4 options, and the option ID and length limits", () => {
    const option = (id: string) => ({ id, label: "Label", consequence: "What follows." });
    expect(errorsOf(answerOf((plan) => { plan["decisions"][0]["id"] = "choice"; }))).toEqual(["decision choice: id should be d1, d2 and so on"]);
    expect(errorsOf(answerOf((plan) => { plan["decisions"][0]["id"] = "d0"; }))).toEqual([expect.stringContaining("id should be d1")]);
    expect(errorsOf(answerOf((plan) => { plan["decisions"][0]["options"] = ["a", "b", "c", "d", "e"].map(option); })))
      .toEqual(["decision d1: options has too many items (at most 4)"]);
    expect(parsePlanDocument(answerOf((plan) => { plan["decisions"][0]["options"] = ["a", "b", "c", "d"].map(option); plan["decisions"][0]["recommended"] = "a"; }), { kind: "design" }).ok).toBe(true);
    expect(errorsOf(answerOf((plan) => { plan["decisions"][0]["options"][1]["id"] = "A_1"; })))
      .toEqual([expect.stringContaining("decision d1: option A_1 id should be lowercase letters")]);
    expect(errorsOf(answerOf((plan) => { plan["decisions"][0]["options"][1]["id"] = "1x"; }))).toHaveLength(1);
    expect(errorsOf(answerOf((plan) => { plan["decisions"][0]["options"][0]["consequence"] = "c".repeat(201); })))
      .toEqual(["decision d1: option three consequence is too long (at most 200 characters)"]);
    expect(parsePlanDocument(answerOf((plan) => { plan["decisions"][0]["options"][0]["consequence"] = "c".repeat(200); }), { kind: "design" }).ok).toBe(true);
  });
});

describe("lastFencedBlock", () => {
  const text = "```agentx-checks\n{\"checks\":[]}\n```\nprose\n```agentx-plan\nfirst\n```\n```agentx-plan\nsecond\nline\n```\n```json\nother\n```\n";

  it("finds the last closed block with exactly that info string, whichever string it is", () => {
    expect(lastFencedBlock(text, "agentx-plan")).toBe("second\nline");
    expect(lastFencedBlock(text, "agentx-checks")).toBe("{\"checks\":[]}");
    expect(lastFencedBlock(text, "agentx-other")).toBeUndefined();
  });

  it("returns null when the last block with that info string is not closed", () => {
    expect(lastFencedBlock(`${text}\`\`\`agentx-plan\nopen`, "agentx-plan")).toBeNull();
  });
});

describe("parsePlanDocument checks on a coding plan", () => {
  const second = rawCheck({ label: "Web lint", cwd: "workspace/payments/app", executable: "./scripts/lint.sh", args: [], timeoutSeconds: 1800, proves: ["2", "1.1"] });
  const answerWith = (checks: unknown) => planAnswer(planDocument(), { checks: checks as RawChecksInput });

  it("keeps validated checks in the plan, with what each proves", () => {
    const result = parsePlanDocument(answerWith({ checks: [rawCheck(), second], none_reason: null }), codingInput);
    expect(result.ok && result.plan.checks).toEqual({
      proposed: [
        { id: "proposed-1", label: "Retry tests", command: { cwd: "workspace/payments", executable: "npx", args: ["vitest", "run", "tests/retry.test.ts"], timeoutSeconds: 600 } },
        { id: "proposed-2", label: "Web lint", command: { cwd: "workspace/payments/app", executable: "./scripts/lint.sh", args: [], timeoutSeconds: 1800 } },
      ],
      proves: { "proposed-1": ["1"], "proposed-2": ["2", "1.1"] },
    });
    expect(result.ok && result.proposal).toEqual({ proposed: result.ok ? result.plan.checks?.proposed : [] });
  });

  it("keeps the reason for proposing no checks", () => {
    const result = parsePlanDocument(answerWith({ checks: [], none_reason: "Docs-only change." }), codingInput);
    expect(result.ok && result.plan.checks).toEqual({ proposed: [], noneReason: "Docs-only change.", proves: {} });
    expect(result.ok && result.proposal).toEqual({ proposed: [], noneReason: "Docs-only change." });
  });

  it("proposes nothing when the plan has no checks member", () => {
    const result = parsePlanDocument(planAnswer(planDocument()), codingInput);
    expect(result.ok && result.proposal).toEqual({ proposed: [] });
    expect(result.ok && result.plan.checks).toEqual({ proposed: [], proves: {} });
  });

  it("marks the checks unreadable, but keeps the plan, when a check proves a claim the plan lacks", () => {
    const result = parsePlanDocument(answerWith({ checks: [rawCheck({ proves: ["7"] })] }), codingInput);
    expect(result.ok && result.proposal).toEqual({ proposed: [], proposalNote: UNREADABLE });
    expect(result.ok && result.plan.checks).toEqual({ proposed: [], proposalNote: UNREADABLE, proves: {} });
  });

  it("lets a check prove a Not changing entry as nc1, nc2 and so on, and refuses one past the last entry", () => {
    const plan = planDocument({ notChanging: ["The refund flow stays as it is.", "Receipts keep their layout."] });
    const readWith = (proves: string[]) => parsePlanDocument(planAnswer(plan, { checks: { checks: [rawCheck({ proves })] } }), codingInput);
    expect(readWith(["nc2", "1"]).ok && (readWith(["nc2", "1"]) as { plan: PlanDocument }).plan.checks?.proves).toEqual({ "proposed-1": ["nc2", "1"] });
    for (const proves of [["nc3"], ["nc0"], ["nc01"], ["NC1"], ["nc"]]) {
      const result = readWith(proves);
      expect(result.ok && result.proposal).toEqual({ proposed: [], proposalNote: UNREADABLE });
    }
    const stored = planDocument({ notChanging: ["One."], checks: { proposed: [{ id: "proposed-1", label: "t", command: { cwd: "workspace/a", executable: "npm", args: [], timeoutSeconds: 60 } }], proves: { "proposed-1": ["nc1"] } } });
    expect(readCanonicalPlan(JSON.stringify(stored))).toBeDefined();
    const past = planDocument({ notChanging: ["One."], checks: { proposed: stored.checks!.proposed, proves: { "proposed-1": ["nc2"] } } });
    expect(readCanonicalPlan(JSON.stringify(past))).toBeUndefined();
  });

  it("marks the checks unreadable, but keeps the plan, when a check argument or label holds a control character", () => {
    for (const overrides of [{ args: ["-e", "a\nb"] }, { args: ["a\tb"] }, { args: ["a\u007fb"] }, { label: "Retry\u0007tests" }]) {
      const result = parsePlanDocument(answerWith({ checks: [rawCheck(overrides)] }), codingInput);
      expect(result.ok && result.proposal).toEqual({ proposed: [], proposalNote: UNREADABLE });
    }
  });

  it("tells the planner, without a checks input (the worker's format retry), which check has a line break or control character", () => {
    const worker = (check: Record<string, unknown>) => errorsOf(answerOf(() => undefined, { checks: [check] }), "plan");
    expect(worker(rawCheck({ label: "Probe", args: ["-c", "print(1)\nprint(2)"] }))).toEqual([
      "check Probe: arguments may not contain line breaks or control characters; write \\n as a two-character escape inside your script if you need it",
    ]);
    expect(worker(rawCheck({ label: "Bad\u0001label" }))).toEqual([expect.stringMatching(/^check Bad label: the label may not contain line breaks or control characters/)]);
    expect(parsePlanDocument(answerOf(() => undefined, { checks: [rawCheck({ args: ["fine"] })] }), { kind: "plan" }).ok).toBe(true);
  });

  it("marks the checks unreadable, but keeps the plan, when a check runs outside the repositories", () => {
    const result = parsePlanDocument(answerWith({ checks: [rawCheck({ cwd: "workspace/elsewhere" })] }), codingInput);
    expect(result.ok && result.proposal).toEqual({ proposed: [], proposalNote: UNREADABLE });
  });

  it("drops a check that repeats a required one, and merges what a repeated proposal proves", () => {
    const repeatsRequired = rawCheck({ executable: "npm", args: ["test"], proves: ["2"] });
    const result = parsePlanDocument(answerWith({ checks: [repeatsRequired, rawCheck({ proves: ["1"] }), rawCheck({ proves: ["2"] })] }), codingInput);
    expect(result.ok && result.plan.checks?.proves).toEqual({ "proposed-1": ["1", "2"] });
  });
});

describe("canonicalPlanJson", () => {
  it("is the same for two objects with different key order", () => {
    const a = planDocument();
    const reordered = JSON.parse(JSON.stringify({ decisions: a.decisions, risks: a.risks, notChanging: a.notChanging, claims: a.claims.map((c) => ({ text: c.text, id: c.id, ...(c.children === undefined ? {} : { children: c.children }), ...(c.evidence === undefined ? {} : { evidence: c.evidence }) })), why: a.why, title: a.title, schemaVersion: 1 }));
    expect(canonicalPlanJson(reordered as PlanDocument)).toBe(canonicalPlanJson(a));
    expect(canonicalPlanJson(a)).not.toMatch(/\s{2}|\n/);
  });

  it("changes when a claim's text changes or a proposed check changes", () => {
    const base = planDocument();
    const edited = planDocument({ claims: [{ ...base.claims[0]!, text: "Changed." }, base.claims[1]!] });
    expect(canonicalPlanJson(edited)).not.toBe(canonicalPlanJson(base));
    const withChecks = (executable: string) => {
      const result = parsePlanDocument(planAnswer(base, { checks: { checks: [rawCheck({ executable })] } }), codingInput);
      if (!result.ok) throw new Error(result.errors.join("; "));
      return canonicalPlanJson(result.plan);
    };
    expect(withChecks("npx")).not.toBe(withChecks("pnpm"));
    expect(withChecks("npx")).not.toBe(canonicalPlanJson(base));
  });

  it("round-trips a stored plan, with or without checks, through readCanonicalPlan", () => {
    expect(readCanonicalPlan(canonicalPlanJson(planDocument()))).toEqual(planDocument());
    const result = parsePlanDocument(planAnswer(planDocument(), { checks: { checks: [rawCheck()], none_reason: null } }), codingInput);
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(readCanonicalPlan(canonicalPlanJson(result.plan))).toEqual(result.plan);
  });
});

describe("readCanonicalPlan", () => {
  it("keeps a stored why entry of up to 4,000 characters (the owner's request), while a planner's own entry stays at 500", () => {
    const long = planDocument({ why: [{ text: "r".repeat(4_000), author: "Priya" }] });
    expect(readCanonicalPlan(canonicalPlanJson(long))?.why[0]?.text).toHaveLength(4_000);
    expect(readCanonicalPlan(canonicalPlanJson(planDocument({ why: [{ text: "r".repeat(4_001), author: "Priya" }] })))).toBeUndefined();
    expect(errorsOf(planAnswer(planDocument({ why: [{ text: "r".repeat(501), author: "Priya" }] })))).toHaveLength(1);
  });

  it("returns undefined for anything that is not a valid stored plan", () => {
    expect(readCanonicalPlan("not json")).toBeUndefined();
    expect(readCanonicalPlan("[]")).toBeUndefined();
    expect(readCanonicalPlan(JSON.stringify({ ...planDocument(), extra: 1 }))).toBeUndefined();
    const duplicate = planDocument();
    duplicate.claims[1] = { ...duplicate.claims[1]!, id: "1" };
    expect(readCanonicalPlan(JSON.stringify(duplicate))).toBeUndefined();
    const dangling = planDocument({ checks: { proposed: [], proves: { "proposed-1": ["1"] } } });
    expect(readCanonicalPlan(JSON.stringify(dangling))).toBeUndefined();
    const unknownClaim = planDocument({ checks: { proposed: [{ id: "proposed-1", label: "t", command: { cwd: "workspace/a", executable: "npm", args: [], timeoutSeconds: 60 } }], proves: { "proposed-1": ["99"] } } });
    expect(readCanonicalPlan(JSON.stringify(unknownClaim))).toBeUndefined();
  });
});

describe("planClaimIds and retiredClaimIds", () => {
  it("lists claim IDs depth first in document order", () => {
    expect(planClaimIds(planDocument())).toEqual(["1", "1.1", "2"]);
  });

  it("retires what the latest earlier version dropped", () => {
    const withIds = (ids: string[]) => planDocument({ claims: ids.map((id) => ({ id, text: `Claim ${id}.` })), decisions: [] });
    expect([...retiredClaimIds([withIds(["1", "2", "3"]), withIds(["1", "2"])])]).toEqual(["3"]);
    expect(retiredClaimIds([]).size).toBe(0);
    expect(retiredClaimIds([withIds(["1", "2"])]).size).toBe(0);
  });
});

describe("WorkflowArtifactSchema", () => {
  const artifact = {
    id: "plan-2", type: "plan", version: 2, sha256: "a".repeat(64), producer: "planner", objectKey: "tasks/t1/plan-2.json", createdAt: "2026-10-09T12:00:00.000Z",
  };

  it("accepts a structured artifact with evidence, and a legacy artifact with neither field", () => {
    expect(WorkflowArtifactSchema.safeParse({ ...artifact, format: "structured", evidence: { objectKey: "tasks/t1/plan-2-evidence.json", sha256: "b".repeat(64) } }).success).toBe(true);
    expect(WorkflowArtifactSchema.safeParse(artifact).success).toBe(true);
    expect(WorkflowArtifactSchema.safeParse({ ...artifact, format: "markdown" }).success).toBe(true);
  });

  it("refuses evidence without the structured format, and an unsafe evidence key", () => {
    const evidence = { objectKey: "tasks/t1/plan-2-evidence.json", sha256: "b".repeat(64) };
    expect(WorkflowArtifactSchema.safeParse({ ...artifact, evidence }).success).toBe(false);
    expect(WorkflowArtifactSchema.safeParse({ ...artifact, format: "markdown", evidence }).success).toBe(false);
    expect(WorkflowArtifactSchema.safeParse({ ...artifact, format: "structured", evidence: { ...evidence, objectKey: "../escape" } }).success).toBe(false);
  });

  it("has a block reason for a plan that could not be read", () => {
    expect(WORKFLOW_BLOCK_REASONS.planUnreadable).toBe("the plan couldn't be read");
  });
});

describe("planDocumentMarkdown", () => {
  const sha256 = `abcdef0123456789${"0".repeat(48)}`;
  const markdown = (plan: PlanDocument, extra: { answers?: "recommended"; kind?: "requirements" | "design" | "plan" } = {}) =>
    planDocumentMarkdown(plan, { kind: extra.kind ?? "design", version: 2, sha256, ...(extra.answers === undefined ? {} : { answers: extra.answers }) });

  it("writes the document in the agreed layout", () => {
    expect(markdown(planDocument())).toMatchInlineSnapshot(`
      "# Design v2 (sha256 abcdef012345): Retry failed payments
      ## Why
      > Failed payments are dropped without a retry. (from Priya)
      ## Claims
      - **1** Payments that fail with a timeout are retried.
        - Evidence: code \`payments/src/charge.ts\` lines 10-24 — Today a timeout throws.
        - **1.1** The retry waits longer each time.
      - **2** A payment is never charged twice.
      ## Decisions
      - **d1** (on claim 1) How many times should a payment be retried?
        - Three times: Most timeouts clear by the third try. (AgentX recommends this)
        - Five times: Customers wait longer before seeing a failure.
      ## Not changing
      - The refund flow stays as it is.
      ## Risks
      - A slow gateway could keep a retry open for a long time.
      "
    `);
  });

  it("names the kind and adds the answered sentence only when asked", () => {
    expect(markdown(planDocument(), { kind: "requirements" }).split("\n")[0]).toBe("# Requirements v2 (sha256 abcdef012345): Retry failed payments");
    expect(markdown(planDocument(), { kind: "plan" }).split("\n")[0]).toMatch(/^# Coding plan v2 /);
    const sentence = "The owner approved AgentX's recommended answer to every decision; treat each as decided.";
    expect(markdown(planDocument())).not.toContain(sentence);
    expect(markdown(planDocument(), { answers: "recommended" })).toContain(`## Decisions\n${sentence}\n- **d1**`);
  });

  it("renders every kind of evidence", () => {
    const plan = planDocument({
      claims: [{
        id: "1", text: "All the evidence.",
        evidence: [
          { kind: "sketch", language: "ts", code: "const a = 1;\nconst b = 2;" },
          { kind: "flow", participants: ["A", "B", "C"], steps: [{ from: "A", to: "B", label: "ask" }, { from: "B", to: "C", label: "forward" }] },
          { kind: "schema", entities: [{ name: "Payment", fields: [{ name: "id", type: "uuid" }, { name: "state", type: "text" }] }, { name: "Retry", fields: [] }], relations: [{ from: "Retry", to: "Payment", label: "retries" }] },
        ],
        children: [{ id: "1.1", text: "Nested.", evidence: [
          { kind: "stateMachine", states: ["Draft", "Scheduled"], initial: "Draft", transitions: [{ from: "Draft", to: "Scheduled", label: "schedule" }] },
          { kind: "quote", text: "Please retry.", author: "Priya" },
        ] }],
      }],
      decisions: [],
    });
    expect(markdown(plan).split("\n").slice(4, 19)).toEqual([
      "- **1** All the evidence.",
      "  - Evidence: sketch (ts):",
      "    ```ts",
      "    const a = 1;",
      "    const b = 2;",
      "    ```",
      "  - Evidence: call flow — 1. A → B: ask; 2. B → C: forward",
      "  - Evidence: schema — Payment(id: uuid, state: text); Retry(); relations: Retry → Payment (retries)",
      "  - **1.1** Nested.",
      "    - Evidence: states — Draft → Scheduled (schedule); starts at Draft",
      "    - Evidence: quote — \"Please retry.\" (Priya)",
      "## Not changing",
      "- The refund flow stays as it is.",
      "## Risks",
      "- A slow gateway could keep a retry open for a long time.",
    ]);
  });

  it("uses a fence longer than any backtick run inside sketch code", () => {
    const code = "const s = `x`;\n```\nnested\n```";
    const lines = markdown(planDocument({ claims: [{ id: "1", text: "Sketch.", evidence: [{ kind: "sketch", language: "md", code }] }], decisions: [] })).split("\n");
    expect(lines).toContain("    ````md");
    expect(lines.filter((entry) => entry === "    ````")).toHaveLength(1);
  });

  it("redacts secrets in every part of the document", () => {
    const secret = "AKIAABCDEFGHIJKLMNOP";
    const text = markdown(planDocument({
      title: `Title ${secret}`,
      claims: [{ id: "1", text: `Claim ${secret}`, evidence: [{ kind: "sketch", language: "ts", code: `const key = "${secret}";` }, { kind: "quote", text: secret, author: "Priya" }] }],
      risks: [`Risk ${secret}`],
    }));
    expect(text).not.toContain(secret);
    expect(text).toContain("Claim ");
  });

  it("lists the checks with the claims each proves, and the reason when none apply", () => {
    const check = { id: "proposed-1", label: "Retry tests", command: { cwd: "workspace/payments", executable: "npx", args: ["vitest", "run", "tests/retry.test.ts"], timeoutSeconds: 600 } };
    const withChecks = markdown(planDocument({ checks: { proposed: [check], proves: { "proposed-1": ["1.1", "2"] } } }), { kind: "plan" });
    expect(withChecks).toContain("## Checks\n- Retry tests: `npx vitest run tests/retry.test.ts` in `workspace/payments` — proves 1.1, 2\n");
    expect(markdown(planDocument({ checks: { proposed: [], noneReason: "Docs only.", proves: {} } }), { kind: "plan" })).toContain("## Checks\n- None apply: Docs only.\n");
    expect(markdown(planDocument({ checks: { proposed: [], proves: {} } }), { kind: "plan" })).not.toContain("## Checks");
    expect(markdown(planDocument())).not.toContain("## Checks");
  });

  it("writes a Not changing proof as \"Not changing N\"", () => {
    const check = { id: "proposed-1", label: "Refund tests", command: { cwd: "workspace/payments", executable: "npm", args: ["test"], timeoutSeconds: 600 } };
    const text = markdown(planDocument({ notChanging: ["a", "b"], checks: { proposed: [check], proves: { "proposed-1": ["1", "nc2"] } } }), { kind: "plan" });
    expect(text).toContain("— proves 1, Not changing 2\n");
  });

  it("redacts secrets that sit in separate arguments of a check command", () => {
    const check = { id: "proposed-1", label: "Probe", command: { cwd: "workspace/payments", executable: "tool", args: ["--token", "abcdef1234567890xyz", "--password", "hunter2hunter2"], timeoutSeconds: 600 } };
    const text = markdown(planDocument({ checks: { proposed: [check], proves: { "proposed-1": ["1"] } } }), { kind: "plan" });
    expect(text).not.toContain("abcdef1234567890xyz");
    expect(text).not.toContain("hunter2hunter2");
    expect(text).toContain("- Probe: `tool --token [REDACTED] --password [REDACTED]` in `workspace/payments` — proves 1");
  });

  it("keeps a schema field's note", () => {
    const schema = { kind: "schema" as const, entities: [{ name: "Payment", fields: [{ name: "id", type: "uuid", note: "set by the gateway" }, { name: "state", type: "text" }] }], relations: [] };
    expect(markdown(planDocument({ claims: [{ id: "1", text: "Schema.", evidence: [schema] }], decisions: [] }))).toContain("  - Evidence: schema — Payment(id: uuid — set by the gateway, state: text)\n");
  });

  it("keeps a multi-line claim on one line", () => {
    expect(markdown(planDocument({ claims: [{ id: "1", text: "One\n## Not a heading" }], decisions: [] }))).toContain("- **1** One ## Not a heading\n");
  });
});

describe("planSummaryLines", () => {
  const claims = (count: number) => Array.from({ length: count }, (_, index) => ({ id: String(index + 1), text: `Claim ${index + 1}.`, children: [{ id: `${index + 1}.1`, text: "Child." }] }));

  it("returns the top-level claims in ranked order, three by default", () => {
    expect(planSummaryLines(planDocument({ claims: claims(5), decisions: [] }))).toEqual(["Claim 1.", "Claim 2.", "Claim 3."]);
    expect(planSummaryLines(planDocument({ claims: claims(5), decisions: [] }), 2)).toEqual(["Claim 1.", "Claim 2."]);
    expect(planSummaryLines(planDocument({ claims: claims(1), decisions: [] }), 10)).toEqual(["Claim 1."]);
  });

  it("redacts and shortens each line to 160 characters", () => {
    const long = planSummaryLines(planDocument({ claims: [{ id: "1", text: `${"word ".repeat(70)}end` }], decisions: [] }));
    expect(long[0]).toHaveLength(160);
    expect(long[0]?.endsWith("…")).toBe(true);
    const secret = "AKIAABCDEFGHIJKLMNOP";
    expect(planSummaryLines(planDocument({ claims: [{ id: "1", text: `Use ${secret}` }], decisions: [] })).join()).not.toContain(secret);
  });
});

describe("diffPlanDocuments", () => {
  it("reports no change for the same plan, even with keys in another order", () => {
    const plan = planDocument();
    const reordered = JSON.parse(JSON.stringify({ decisions: plan.decisions, claims: plan.claims.map((entry) => ({ children: entry.children, text: entry.text, id: entry.id, evidence: entry.evidence })), risks: plan.risks, notChanging: plan.notChanging, why: plan.why, title: plan.title, schemaVersion: 1 })) as PlanDocument;
    expect(diffPlanDocuments(plan, reordered)).toEqual({ added: [], removed: [], changed: [], decisionsAdded: [], decisionsRemoved: [], decisionsChanged: [] });
  });

  it("reports added, removed and changed claims by ID, including nested ones", () => {
    const previous = planDocument();
    const next = planDocument({
      claims: [
        { id: "1", text: "Payments that fail with a timeout are retried.", evidence: [{ kind: "code", path: "payments/src/charge.ts", startLine: 10, endLine: 30 }], children: [{ id: "1.1", text: "The retry waits longer each time, up to a minute." }, { id: "1.2", text: "New." }] },
        { id: "3", text: "Added." },
      ],
    });
    expect(diffPlanDocuments(previous, next)).toMatchObject({ added: ["1.2", "3"], removed: ["2"], changed: ["1", "1.1"] });
  });

  it("does not count a parent as changed when only a child changed", () => {
    const next = planDocument({ claims: [{ ...planDocument().claims[0]!, children: [{ id: "1.1", text: "Different." }] }, planDocument().claims[1]!] });
    expect(diffPlanDocuments(planDocument(), next).changed).toEqual(["1.1"]);
  });

  it("reports added, removed and changed decisions", () => {
    const base = planDocument().decisions[0]!;
    const previous = planDocument({ decisions: [base, { ...base, id: "d2" }] });
    const next = planDocument({ decisions: [{ ...base, recommended: "five" }, { ...base, id: "d3" }] });
    expect(diffPlanDocuments(previous, next)).toMatchObject({ decisionsAdded: ["d3"], decisionsRemoved: ["d2"], decisionsChanged: ["d1"] });
  });
});

describe("planClaimCount", () => {
  it("counts nested claims", () => {
    expect(planClaimCount(planDocument())).toBe(3);
    expect(planClaimCount(planDocument({ claims: [{ id: "1", text: "A.", children: [{ id: "1.1", text: "B.", children: [{ id: "1.1.1", text: "C." }] }] }], decisions: [] }))).toBe(3);
  });
});
