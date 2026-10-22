import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { E2E_APPLICATION_GROUP_EVIDENCE_MAX_BYTES, e2eAgentValueKeyId, e2eModelRouteRevision, type E2EModelReceipt, type E2EModelRouteDefinition, type E2ERoundScope } from "@agentx/contracts";
import { deriveE2EAgentRoute, scriptedE2ERouteDefinition } from "../../packages/model-runtime/src/e2e-route-derive.js";
import { E2EAgentModelEvidenceSchema, E2E_AGENT_LEDGER_MAX_BYTES, evaluateE2EAgentCase, type E2EAgentCaseInput, type E2EAgentUnknownCode } from "../../packages/verifier/src/application-agent-result.js";

// Task 4.4a: the verdict of the AI-navigation part of one case, as a pure function over receipts, the action ledger, the e2e report's own account of the step and the approved goals.
// Cases 1-20 of the plan (the adapter end to end is tests/unit/e2e-agent-collection.test.ts).
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const KEY = "ab".repeat(32);
const RUN = "11111111-1111-4111-8111-111111111111";
const CASE = "agent-export";
const GOAL = "Export the orders as a CSV file";
const GOAL_2 = "Open the second page";
const route: E2EModelRouteDefinition = scriptedE2ERouteDefinition();
const REVISION = e2eModelRouteRevision(route);
const T0 = Date.parse("2026-10-22T10:00:00.000Z");

let counter = 0;
function receipt(over: Partial<E2EModelReceipt> & { stepIndex?: number; callIndex?: number } = {}): E2EModelReceipt {
  const outcome = over.outcome ?? "ok";
  const refused = outcome === "refused-credential-match" || outcome === "refused-protocol" || outcome === "refused-busy";
  const answered = outcome === "ok" || outcome === "invalid-output";
  counter += 1;
  return { receiptId: `rcpt-${counter}`, runId: RUN, caseId: CASE, stepIndex: 1, callIndex: 0, routeId: route.routeId, routeRevision: REVISION, provider: route.provider, modelId: route.modelId,
    startedAt: new Date(T0 + (over.callIndex ?? 0) * 1000).toISOString(), inputTokens: refused ? 0 : 100, outputTokens: refused ? 0 : 10, latencyMs: 5, servedModelId: null, servedUpstream: null,
    promptSha256: sha(`prompt-${counter}`), responseSha256: answered ? sha(`response-${counter}`) : null, outcome, ...over };
}
const ok = (stepIndex: number, callIndex: number) => receipt({ stepIndex, callIndex });
const tap = (name = "Download orders", testId = "download-orders") => ({ tool: "tap" as const, node: { role: "button", name, testId }, valueDigest: null, valueLiteral: null, url: null,
  snapshotSha256: sha("screen"), outcome: "ok" as const });
type LedgerStepSpec = { stepIndex: number; goal: string; verdict?: "concluded" | "failed" | "cut-short"; stopCode?: string | null; actions?: ReturnType<typeof tap>[]; receipts: E2EModelReceipt[] };
function ledger(steps: LedgerStepSpec[], over: Record<string, unknown> = {}) {
  return { schemaVersion: "rovara-agent-actions/v1", runId: RUN, caseId: CASE, valueKeyId: e2eAgentValueKeyId(KEY),
    steps: steps.map((step) => ({ stepIndex: step.stepIndex, goalDigest: sha(step.goal), verdict: step.verdict ?? "concluded", actions: step.actions ?? [tap()],
      stopCode: step.stopCode ?? null, receiptIds: step.receipts.map((item) => item.receiptId) })), ...over };
}
const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const digestsFor = (receipts: readonly E2EModelReceipt[]) => receipts.map((item) => ({ receiptId: item.receiptId, promptSha256: item.promptSha256, responseSha256: item.responseSha256, omitted: null }));
const CLEAN_CHANNEL = { droppedRequests: 0, unscopedRequests: 0, overrun: false, evidenceErrors: 0 };

type CaseOver = Omit<Partial<E2EAgentCaseInput>, "receipts"> & { receipts?: E2EModelReceipt[]; ledgerOver?: Record<string, unknown>; step?: Partial<LedgerStepSpec>;
  report?: Partial<NonNullable<E2EAgentCaseInput["agentSteps"][number]["report"]>> | null; maxActions?: number };
/** A case with one agent step (declared index 1) that concluded after one tap and two ok model calls; `over` changes any part of it. */
function concluded(over: CaseOver = {}): E2EAgentCaseInput {
  const receipts = over.receipts ?? [ok(1, 0), ok(1, 1)];
  const spec: LedgerStepSpec = { stepIndex: 1, goal: GOAL, receipts, ...over.step };
  const failed = (spec.verdict ?? "concluded") === "failed";
  const report = over.report === null ? null : { modelCalls: receipts.filter((item) => item.outcome === "ok").length, actionSteps: (spec.actions ?? [tap()]).length,
    status: (spec.verdict ?? "concluded") === "concluded" ? "passed" : "failed", errorCode: failed ? spec.stopCode ?? null : null, ...over.report };
  const rest = Object.fromEntries(Object.entries(over).filter(([key]) => !["receipts", "ledgerOver", "step", "report", "maxActions"].includes(key))) as Partial<E2EAgentCaseInput>;
  return { roundScope: "qualification", runId: RUN, caseId: CASE, route, agentSteps: [{ declaredStepIndex: 1, goal: GOAL, maxActions: over.maxActions ?? 4, report }],
    receipts, ledgerBytes: bytesOf(ledger([spec], over.ledgerOver)), valueKey: KEY, transcriptDigests: digestsFor(receipts), channel: CLEAN_CHANNEL, csvDownload: "captured", ...rest };
}
/** The input of a case whose one step ended with `stopCode` (a failed step) and the given receipts. */
function stopped(stopCode: string, receipts: E2EModelReceipt[], over: CaseOver = {}): E2EAgentCaseInput {
  return concluded({ receipts, step: { verdict: "failed", stopCode, actions: [] }, ...over });
}
const codeOf = (input: E2EAgentCaseInput): E2EAgentUnknownCode | "deterministic" => {
  const result = evaluateE2EAgentCase(input);
  return result.verdict.kind === "deterministic" ? "deterministic" : result.verdict.code;
};

describe("evaluateE2EAgentCase: a clean agent part leaves the verdict to the assertions", () => {
  it("1. a concluded step with a captured download and receipts equal to the report's model calls is deterministic, and names its receipts sorted", () => {
    const receipts = [ok(1, 0), ok(1, 1)];
    const result = evaluateE2EAgentCase(concluded({ receipts }));
    expect(result.verdict).toEqual({ kind: "deterministic" });
    expect(result.verifiedReceiptIds).toEqual(receipts.map((item) => item.receiptId).sort());
    expect(result.ledger?.steps[0]).toMatchObject({ stepIndex: 1, verdict: "concluded" });
    expect(result.matched).toEqual([]);
  });

  it("3. a concluded step that took no action and left no download is agent-no-download, never deterministic", () => {
    const receipts = [ok(1, 0)];
    expect(codeOf(concluded({ receipts, step: { actions: [] }, csvDownload: "none" }))).toBe("agent-no-download");
  });

  it("9. two downloads are ambiguous-download", () => {
    expect(codeOf(concluded({ csvDownload: "multiple" }))).toBe("ambiguous-download");
  });

  it("a download that was not needed (no CSV assertion) never raises a download code", () => {
    expect(codeOf(concluded({ csvDownload: "not-applicable" }))).toBe("deterministic");
  });
});

describe("evaluateE2EAgentCase: the fixed UNKNOWN codes", () => {
  it("4. STEP_BUDGET_EXHAUSTED is agent-budget-exhausted, whatever the assertions would say", () => {
    expect(codeOf(stopped("STEP_BUDGET_EXHAUSTED", [ok(1, 0), ok(1, 1)], { csvDownload: "captured" }))).toBe("agent-budget-exhausted");
  });

  it("5. STEP_TIMEOUT is agent-timeout", () => {
    expect(codeOf(stopped("STEP_TIMEOUT", [ok(1, 0)]))).toBe("agent-timeout");
  });

  it("6. a provider-error receipt with MODEL_PROVIDER_FAILED is model-unavailable; so is a timeout receipt", () => {
    expect(codeOf(stopped("MODEL_PROVIDER_FAILED", [receipt({ outcome: "provider-error" })]))).toBe("model-unavailable");
    expect(codeOf(stopped("MODEL_UNAVAILABLE", [receipt({ outcome: "timeout", latencyMs: 30_000 })]))).toBe("model-unavailable");
    expect(codeOf(stopped("MODEL_PROVIDER_FAILED", []))).toBe("model-unavailable");
  });

  it("7. MODEL_OUTPUT_INVALID and STEP_NO_CONCLUSION are agent-navigation-incomplete", () => {
    expect(codeOf(stopped("MODEL_OUTPUT_INVALID", [receipt({ outcome: "invalid-output" })]))).toBe("agent-navigation-incomplete");
    expect(codeOf(stopped("STEP_NO_CONCLUSION", [ok(1, 0)]))).toBe("agent-navigation-incomplete");
  });

  it("8. any other stop code, and a ledger that was cut short, are agent-navigation-incomplete", () => {
    expect(codeOf(stopped("LOCATOR_NOT_FOUND", [ok(1, 0)]))).toBe("agent-navigation-incomplete");
    expect(codeOf(concluded({ receipts: [ok(1, 0)], step: { verdict: "cut-short", actions: [] }, report: { status: "failed", errorCode: null } }))).toBe("agent-navigation-incomplete");
  });

  it("a step that concluded after an invalid answer was asked again; it is not held against the step", () => {
    const receipts = [receipt({ outcome: "invalid-output", callIndex: 0 }), ok(1, 1), ok(1, 2)];
    expect(codeOf(concluded({ receipts, report: { modelCalls: 2 } }))).toBe("deterministic");
  });

  it("10. a credential refusal is model-prompt-credential-match, and wins over a provider-failed stop code", () => {
    const receipts = [ok(1, 0), receipt({ outcome: "refused-credential-match", callIndex: 1 })];
    expect(codeOf(stopped("MODEL_PROVIDER_FAILED", receipts, { report: { modelCalls: 1 } }))).toBe("model-prompt-credential-match");
  });

  it("11. a budget refusal in the step is model-route-budget-exhausted; so is a group over its call budget", () => {
    expect(codeOf(stopped("STEP_BUDGET_EXHAUSTED", [ok(1, 0), receipt({ outcome: "budget", callIndex: 1 })], { report: { modelCalls: 1 } }))).toBe("model-route-budget-exhausted");
    const own = [ok(1, 0), ok(1, 1)];
    const others = Array.from({ length: 39 }, (_, index) => receipt({ caseId: "other-case", stepIndex: 2, callIndex: index }));
    expect(codeOf(concluded({ receipts: own, groupReceipts: [...own, ...others] }))).toBe("model-route-budget-exhausted");
    expect(codeOf(concluded({ receipts: own, groupReceipts: [...own, ...others.slice(0, 38)] }))).toBe("deterministic");
  });
});

describe("evaluateE2EAgentCase: anything that does not agree is model-receipts-mismatch", () => {
  const accountingCases: Array<[string, () => E2EAgentCaseInput]> = [
    ["receipt-identity-mismatch (another route revision)", () => concluded({ receipts: [ok(1, 0), receipt({ callIndex: 1, routeRevision: "r2-aaaaaaaaaaaa" })] })],
    ["receipt-index-gap", () => concluded({ receipts: [ok(1, 0), ok(1, 2)] })],
    ["receipt-duplicate-id", () => { const one = ok(1, 0); return concluded({ receipts: [one, { ...ok(1, 1), receiptId: one.receiptId }] }); }],
    ["receipt-served-model-mismatch", () => concluded({ receipts: [ok(1, 0), receipt({ callIndex: 1, servedModelId: "some-other-model" })] })],
    ["over-step-budget (13 calls in a 12-call step)", () => concluded({ receipts: Array.from({ length: 13 }, (_, index) => ok(1, index)), report: { modelCalls: 13 } })],
    ["report-calls-mismatch (the report counts one call more than the receipts)", () => concluded({ report: { modelCalls: 3 } })],
    ["receipt-not-admissible (a scripted receipt in a standard round)", () => concluded({ roundScope: "standard" as E2ERoundScope })],
  ];
  it.each(accountingCases)("12. %s", (_name, build) => {
    expect(codeOf(build())).toBe("model-receipts-mismatch");
  });

  it("13. a ledger that names a receipt the worker never wrote, or one it wrote for another step, is a mismatch", () => {
    const receipts = [ok(1, 0), ok(1, 1)];
    const forged = ledger([{ stepIndex: 1, goal: GOAL, receipts }]);
    forged.steps[0]!.receiptIds.push("rcpt-never-written");
    expect(codeOf(concluded({ receipts, ledgerBytes: bytesOf(forged) }))).toBe("model-receipts-mismatch");
    const otherStep = ok(2, 0);
    const borrowed = ledger([{ stepIndex: 1, goal: GOAL, receipts }]);
    borrowed.steps[0]!.receiptIds.push(otherStep.receiptId);
    const input = concluded({ receipts: [...receipts, otherStep], ledgerBytes: bytesOf(borrowed) });
    expect(codeOf({ ...input, agentSteps: [...input.agentSteps, { declaredStepIndex: 2, goal: GOAL_2, maxActions: 4, report: { modelCalls: 1, actionSteps: 0, status: "passed", errorCode: null } }] })).toBe("model-receipts-mismatch");
  });

  it("14. a missing ledger, a ledger under another run's key, another goal, or a literal that is not in the goal is a mismatch", () => {
    const receipts = [ok(1, 0), ok(1, 1)];
    expect(codeOf(concluded({ receipts, ledgerBytes: null }))).toBe("model-receipts-mismatch");
    expect(codeOf(concluded({ receipts, ledgerOver: { valueKeyId: "c".repeat(64) } }))).toBe("model-receipts-mismatch");
    expect(codeOf(concluded({ receipts, ledgerBytes: bytesOf(ledger([{ stepIndex: 1, goal: "Delete everything", receipts }])) }))).toBe("model-receipts-mismatch");
    const typed = { ...tap("Search", "search"), tool: "type" as const, valueDigest: sha("whatever"), valueLiteral: "not in the goal" };
    expect(codeOf(concluded({ receipts, step: { actions: [typed as never] } }))).toBe("model-receipts-mismatch");
    expect(codeOf(concluded({ receipts, ledgerBytes: new TextEncoder().encode("{not json") }))).toBe("model-receipts-mismatch");
  });

  it("15. more actions in a step than the approved maxActions is a mismatch", () => {
    expect(codeOf(concluded({ step: { actions: [tap(), tap(), tap()] }, maxActions: 2 }))).toBe("model-receipts-mismatch");
    expect(codeOf(concluded({ step: { actions: [tap(), tap(), tap()] }, maxActions: 3 }))).toBe("deterministic");
  });

  it("a ledger over 64 KiB is not a ledger of this run, however well formed", () => {
    const padded = new TextEncoder().encode(`${JSON.stringify(ledger([{ stepIndex: 1, goal: GOAL, receipts: [ok(1, 0)] }]))}${" ".repeat(E2E_AGENT_LEDGER_MAX_BYTES)}`);
    expect(padded.byteLength).toBeGreaterThan(E2E_AGENT_LEDGER_MAX_BYTES);
    const receipts = [ok(1, 0)];
    const body = concluded({ receipts, ledgerBytes: padded });
    expect(codeOf({ ...body, receipts, agentSteps: body.agentSteps.map((step) => ({ ...step, report: { ...step.report!, modelCalls: 1 } })) })).toBe("model-receipts-mismatch");
  });

  it("the ledger and the report must tell one story: a concluded ledger over a failed report, a failed ledger over a passed report, or a different stop code", () => {
    expect(codeOf(concluded({ report: { status: "failed" } }))).toBe("model-receipts-mismatch");
    expect(codeOf(concluded({ report: { errorCode: "STEP_TIMEOUT" } }))).toBe("model-receipts-mismatch");
    expect(codeOf(stopped("STEP_TIMEOUT", [ok(1, 0)], { report: { status: "passed", errorCode: null } }))).toBe("model-receipts-mismatch");
    expect(codeOf(stopped("STEP_TIMEOUT", [ok(1, 0)], { report: { errorCode: "STEP_BUDGET_EXHAUSTED" } }))).toBe("model-receipts-mismatch");
    expect(codeOf(concluded({ report: null }))).toBe("model-receipts-mismatch");
    expect(codeOf(concluded({ report: { actionSteps: 2 } }))).toBe("model-receipts-mismatch");
  });

  it("16. a kept transcript whose prompt or response digest is not the receipt's is a mismatch; a body omitted for budget changes nothing", () => {
    const receipts = [ok(1, 0), ok(1, 1)];
    const digests = digestsFor(receipts);
    expect(codeOf(concluded({ receipts, transcriptDigests: [{ ...digests[0]!, promptSha256: sha("another prompt") }, digests[1]!] }))).toBe("model-receipts-mismatch");
    expect(codeOf(concluded({ receipts, transcriptDigests: [{ ...digests[0]!, responseSha256: sha("another answer") }, digests[1]!] }))).toBe("model-receipts-mismatch");
    expect(codeOf(concluded({ receipts, transcriptDigests: [{ receiptId: digests[0]!.receiptId, promptSha256: null, responseSha256: null, omitted: "budget" }, digests[1]!] }))).toBe("deterministic");
    // A receipt with no transcript record, or a record for no receipt, is a gap in the worker's record.
    expect(codeOf(concluded({ receipts, transcriptDigests: [digests[0]!] }))).toBe("model-receipts-mismatch");
    expect(codeOf(concluded({ receipts, transcriptDigests: [digests[0]!, { ...digests[1]!, receiptId: "rcpt-unknown" }] }))).toBe("model-receipts-mismatch");
  });

  it.each([["dropped requests", { droppedRequests: 1 }], ["unscoped requests", { unscopedRequests: 1 }], ["an overrun", { overrun: true }], ["an evidence error", { evidenceErrors: 1 }]])(
    "17. the channel's own tally shows %s", (_name, fault) => {
      expect(codeOf(concluded({ channel: { ...CLEAN_CHANNEL, ...fault } }))).toBe("model-receipts-mismatch");
    });

  it("receipts of another run, another case or a step this case did not run are a mismatch", () => {
    expect(codeOf(concluded({ receipts: [ok(1, 0), receipt({ callIndex: 1, runId: "22222222-2222-4222-8222-222222222222" })] }))).toBe("model-receipts-mismatch");
    expect(codeOf(concluded({ receipts: [ok(1, 0), receipt({ callIndex: 1, caseId: "another" })] }))).toBe("model-receipts-mismatch");
    expect(codeOf(concluded({ receipts: [ok(1, 0), ok(1, 1), ok(4, 0)] }))).toBe("model-receipts-mismatch");
  });
});

describe("evaluateE2EAgentCase: precedence and shape", () => {
  it("18. integrity beats everything, and a credential refusal beats a timeout", () => {
    const refused = receipt({ outcome: "refused-credential-match", callIndex: 1 });
    expect(codeOf(stopped("STEP_TIMEOUT", [ok(1, 0), refused], { report: { modelCalls: 1 } }))).toBe("model-prompt-credential-match");
    expect(codeOf(stopped("STEP_TIMEOUT", [ok(1, 0), refused], { report: { modelCalls: 1 }, channel: { ...CLEAN_CHANNEL, evidenceErrors: 1 } }))).toBe("model-receipts-mismatch");
  });

  it("returns every code that applied, in order, and the first is the verdict's", () => {
    const refused = receipt({ outcome: "refused-credential-match", callIndex: 1 });
    const result = evaluateE2EAgentCase(stopped("STEP_TIMEOUT", [ok(1, 0), refused], { report: { modelCalls: 1 } }));
    expect(result.matched).toEqual(["model-prompt-credential-match", "agent-timeout"]);
    expect(result.verifiedReceiptIds).toEqual([]);
    expect(result.ledger).not.toBeNull();
  });

  it("20. raw receipts and their parsed form give one verdict: reordered keys, or a missing servedModelId in place of null", () => {
    const input = concluded({ receipts: [ok(1, 0), ok(1, 1)] });
    const reordered = input.receipts.map((item) => Object.fromEntries(Object.entries(item as Record<string, unknown>).reverse()));
    const bare = input.receipts.map((item) => Object.fromEntries(Object.entries(item as Record<string, unknown>).filter(([key]) => key !== "servedModelId" && key !== "servedUpstream")));
    expect(codeOf({ ...input, receipts: reordered })).toBe("deterministic");
    expect(codeOf({ ...input, receipts: bare })).toBe("deterministic");
    expect(codeOf({ ...input, receipts: bare, csvDownload: "none" })).toBe("agent-no-download");
  });

  it("a standard route is judged like the scripted one, and a receipt of another model is a mismatch", () => {
    const derived = deriveE2EAgentRoute({ provider: "amazon-bedrock", region: "us-east-1" }, 3);
    if (derived.status !== "available") throw new Error("the fixture route must be available");
    const standard = derived.definition;
    const revision = e2eModelRouteRevision(standard);
    const mine = (callIndex: number, over: Partial<E2EModelReceipt> = {}) => receipt({ callIndex, routeId: standard.routeId, routeRevision: revision, provider: standard.provider, modelId: standard.modelId, ...over });
    const receipts = [mine(0), mine(1)];
    const input = { ...concluded({ receipts }), route: standard, roundScope: "standard" as const };
    expect(codeOf(input)).toBe("deterministic");
    expect(codeOf({ ...input, receipts: [mine(0), mine(1, { modelId: "other.model-v1" })] })).toBe("model-receipts-mismatch");
  });

  it("never throws: a malformed input is a mismatch", () => {
    expect(codeOf({ ...concluded(), receipts: [null, 3, "x"] as never })).toBe("model-receipts-mismatch");
    expect(codeOf({ ...concluded(), agentSteps: [] })).toBe("model-receipts-mismatch");
    expect(codeOf({ ...concluded(), valueKey: "short" })).toBe("model-receipts-mismatch");
  });
});

describe("the size of the model evidence a group uploads (risk R5)", () => {
  it("a group at the structural worst case (3 agent cases with a ledger at the 64 KiB cap, 300 receipts and their digests) weighs under a seventh of the 8 MiB group ceiling, and the schema accepts it", () => {
    const receipts = Array.from({ length: 300 }, (_, index) => receipt({ callIndex: index % 100, stepIndex: Math.floor(index / 100), servedModelId: route.modelId }));
    const ledgerBytes = new TextEncoder().encode(`{${" ".repeat(E2E_AGENT_LEDGER_MAX_BYTES - 2)}}`);
    const worst = { schemaVersion: "rovara-agent-model-evidence/v1", route, valueKey: KEY, receipts, channel: CLEAN_CHANNEL,
      ledgers: ["a", "b", "c"].map((name) => ({ caseDirectory: sha(name).slice(0, 16), bytesBase64: Buffer.from(ledgerBytes).toString("base64"), sha256: sha(name) })),
      transcriptDigests: digestsFor(receipts) };
    expect(E2EAgentModelEvidenceSchema.safeParse(worst).success).toBe(true);
    const bytes = Buffer.byteLength(JSON.stringify(worst), "utf8");
    expect(bytes).toBeLessThan(E2E_APPLICATION_GROUP_EVIDENCE_MAX_BYTES / 7);
  });

  it("the schema refuses more than 300 receipts, more than 64 ledgers, a ledger past the cap, and any key it does not know", () => {
    const base = { schemaVersion: "rovara-agent-model-evidence/v1", route: null, valueKey: KEY, receipts: [], channel: CLEAN_CHANNEL, ledgers: [], transcriptDigests: [] };
    expect(E2EAgentModelEvidenceSchema.safeParse(base).success).toBe(true);
    expect(E2EAgentModelEvidenceSchema.safeParse({ ...base, receipts: Array.from({ length: 301 }, () => receipt()) }).success).toBe(false);
    const ledgerEntry = { caseDirectory: "0123456789abcdef", bytesBase64: "e30=", sha256: sha("x") };
    expect(E2EAgentModelEvidenceSchema.safeParse({ ...base, ledgers: Array.from({ length: 65 }, () => ledgerEntry) }).success).toBe(false);
    expect(E2EAgentModelEvidenceSchema.safeParse({ ...base, ledgers: [{ ...ledgerEntry, bytesBase64: "A".repeat(Math.ceil(E2E_AGENT_LEDGER_MAX_BYTES * 4 / 3) + 8) }] }).success).toBe(false);
    expect(E2EAgentModelEvidenceSchema.safeParse({ ...base, prompt: "a prompt" }).success).toBe(false);
    expect(E2EAgentModelEvidenceSchema.safeParse({ ...base, valueKey: "short" }).success).toBe(false);
  });
});
