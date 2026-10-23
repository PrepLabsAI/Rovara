import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { e2eAgentValueKeyId, e2eModelRouteRevision, E2E_MODEL_FAILURE_CLASSES, type E2EModelFailure, type E2EModelReceipt, type E2EModelRouteDefinition } from "@agentx/contracts";
import { scriptedE2ERouteDefinition } from "../../packages/model-runtime/src/e2e-route-derive.js";
import { createGovernedE2EModelRoute, createInMemoryE2EDayBudget } from "../../packages/model-runtime/src/e2e-route.js";
import { createE2EProviderInvoke } from "../../packages/model-runtime/src/e2e-provider-invoke.js";
import { createE2EProviderInvokeForTesting } from "../../packages/model-runtime/src/e2e-provider-invoke-testing.js";
import { E2E_OWNER_SENTENCES, modelSentenceContext } from "../../packages/broker/src/e2e/owner-sentences.js";
import { buildScenarioRows } from "../../packages/broker/src/e2e/application-display.js";
import { cleanRedirectingEnvironment } from "../support/e2e-clean-environment.js";
import { PROVIDER_KEY, SECRET_ARN, bedrockRoute, channelRequest, installationEnvironment, keyedRoute } from "../support/e2e-model-fixtures.js";
import { bedrockLoopback, fakeFetch, jsonError } from "../support/e2e-provider-fakes.js";
import { E2E_AGENT_UNKNOWN_CODES, evaluateE2EAgentCase, type E2EAgentCaseInput, type E2EAgentUnknownCode } from "../../packages/verifier/src/application-agent-result.js";

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


const failed = (failureClass: E2EModelFailure["class"] | null, over: Partial<E2EModelReceipt> & { stepIndex?: number; callIndex?: number } = {}): E2EModelReceipt =>
  receipt({ outcome: "provider-error", ...(failureClass === null ? {} : { failure: { class: failureClass, signal: null } }), ...over });
const CLASS_CODE: Record<Exclude<E2EModelFailure["class"], "unknown">, E2EAgentUnknownCode> = {
  "limit-or-rate-limited": "model-limit-reached", "key-rejected": "model-key-rejected", "model-not-found": "model-not-found", unreachable: "model-unreachable",
  "request-rejected": "model-request-rejected", "provider-outage": "model-provider-outage",
};

describe("21. the class of the last failed model call decides the code", () => {
  it("[ok, error{limit}] is model-limit-reached", () => {
    expect(codeOf(stopped("MODEL_PROVIDER_FAILED", [ok(1, 0), failed("limit-or-rate-limited", { callIndex: 1 })]))).toBe("model-limit-reached");
  });

  it("[error{limit}, error{outage}] is model-provider-outage: the last one decides", () => {
    expect(codeOf(stopped("MODEL_PROVIDER_FAILED", [failed("limit-or-rate-limited", { callIndex: 0 }), failed("provider-outage", { callIndex: 1 })]))).toBe("model-provider-outage");
  });

  it("the last one is by step and call index, not by the order the worker listed them in", () => {
    const early = failed("limit-or-rate-limited", { callIndex: 0 });
    const late = failed("key-rejected", { callIndex: 1 });
    expect(codeOf(stopped("MODEL_PROVIDER_FAILED", [late, early]))).toBe("model-key-rejected");
  });

  for (const [failureClass, code] of Object.entries(CLASS_CODE)) {
    it(`${failureClass} is ${code}, as an error and as a timeout`, () => {
      expect(codeOf(stopped("MODEL_PROVIDER_FAILED", [failed(failureClass as E2EModelFailure["class"])]))).toBe(code);
      expect(codeOf(stopped("MODEL_UNAVAILABLE", [failed(failureClass as E2EModelFailure["class"], { outcome: "timeout", latencyMs: 30_000 })]))).toBe(code);
    });
  }

  it("an unknown class, a provider error with no failure (an older worker) and the unavailable stops alone are model-unavailable", () => {
    expect(codeOf(stopped("MODEL_PROVIDER_FAILED", [failed("unknown")]))).toBe("model-unavailable");
    expect(codeOf(stopped("MODEL_PROVIDER_FAILED", [failed(null)]))).toBe("model-unavailable");
    expect(codeOf(stopped("MODEL_UNAVAILABLE", []))).toBe("model-unavailable");
    expect(codeOf(stopped("MODEL_PROVIDER_FAILED", []))).toBe("model-unavailable");
  });

  it("a failed call that came before an ok one still decides (the case could not run to the end), and an old receipt is unchanged", () => {
    expect(codeOf(stopped("MODEL_PROVIDER_FAILED", [failed("request-rejected", { callIndex: 0 }), ok(1, 1)]))).toBe("model-request-rejected");
  });

  it("a failure attached to an ok receipt is refused: the receipts do not verify, so the case is model-receipts-mismatch, never deterministic", () => {
    const tampered = { ...ok(1, 0), failure: { class: "limit-or-rate-limited", signal: null } } as unknown as E2EModelReceipt;
    expect(codeOf(concluded({ receipts: [tampered, ok(1, 1)] }))).toBe("model-receipts-mismatch");
  });

  it("the higher-precedence codes still win: a credential refusal or a spent budget outranks a provider failure", () => {
    expect(codeOf(stopped("MODEL_PROVIDER_FAILED", [receipt({ outcome: "refused-credential-match", callIndex: 0 }), failed("limit-or-rate-limited", { callIndex: 1 })]))).toBe("model-prompt-credential-match");
    const result = evaluateE2EAgentCase(stopped("MODEL_PROVIDER_FAILED", [failed("limit-or-rate-limited")]));
    expect(result.matched).toEqual(["model-limit-reached"]);
  });

  it("no failure class ever produces a deterministic verdict, and every class has exactly one code", () => {
    for (const failureClass of E2E_MODEL_FAILURE_CLASSES) {
      const result = evaluateE2EAgentCase(stopped("MODEL_PROVIDER_FAILED", [failed(failureClass)]));
      expect(result.verdict.kind, failureClass).toBe("unknown");
      expect(result.verifiedReceiptIds, failureClass).toEqual([]);
    }
    expect(E2E_AGENT_UNKNOWN_CODES).toEqual(expect.arrayContaining(Object.values(CLASS_CODE)));
    expect(new Set(E2E_AGENT_UNKNOWN_CODES).size).toBe(E2E_AGENT_UNKNOWN_CODES.length);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 23. No raw text: the whole chain, from a hostile provider answer to the sentence on the page
// ---------------------------------------------------------------------------------------------------------------------

const HOSTILE = ["SECRETVALUE", "hunter2-echo", "x-api-key", "sk-ant-", "the prompt echoed", "internal.amazon.com"];

/** Puts a receipt a real route wrote into this file's case (identity fields only: its outcome, class and signal stay exactly as the invoke produced them). */
const intoCase = (real: E2EModelReceipt, callIndex = 0): E2EModelReceipt =>
  ({ ...real, receiptId: `rcpt-chain-${callIndex}`, runId: RUN, caseId: CASE, stepIndex: 1, callIndex, routeId: route.routeId, routeRevision: REVISION, provider: route.provider, modelId: route.modelId });

function displayed(definition: E2EModelRouteDefinition, code: string) {
  const caseRow = { caseId: CASE, scenarioId: "export-ai", targetId: "web-1", accountProfileId: "orders-owner" };
  const [row] = buildScenarioRows({ authoritative: true, attach: "failed-or-incomplete", targetKinds: new Map([["web-1", "web"]]), groups: [{ verdict: "UNKNOWN", reason: "irrelevant", cases: [caseRow], scenarios: new Map(),
    observed: new Map(), screenshots: new Map(), model: modelSentenceContext(definition),
    result: { cases: [{ caseId: CASE, status: "unavailable", reason: code, assertionReceipts: [{ assertionIndex: 0, status: "unavailable" }] }] } }] }).scenarios;
  return row!;
}

describe("23. nothing a provider said reaches a receipt, a verdict or a row", () => {
  it("a keyed provider's 401 with a key and the prompt in its body becomes the key sentence naming the provider and the model, and nothing else", async () => {
    cleanRedirectingEnvironment();
    const definition = keyedRoute("anthropic");
    const body = { type: "error", error: { type: "authentication_error", message: "invalid x-api-key sk-ant-SECRETVALUE; the prompt echoed hunter2-echo" } };
    const invoke = await createE2EProviderInvoke(definition, { environment: installationEnvironment(definition), readSecret: async (arn) => (arn === SECRET_ARN ? PROVIDER_KEY : undefined),
      fetch: fakeFetch(() => jsonError(401, body)).fetch });
    const outcome = await createGovernedE2EModelRoute(definition, { invoke, now: Date.now, dayBudget: createInMemoryE2EDayBudget() }).generate(channelRequest());
    expect(outcome.receipt.failure).toEqual({ class: "key-rejected", signal: "authentication_error" });
    const verdict = evaluateE2EAgentCase(stopped("MODEL_PROVIDER_FAILED", [intoCase(outcome.receipt)]));
    expect(verdict.verdict).toEqual({ kind: "unknown", code: "model-key-rejected" });
    const shown = displayed(definition, "model-key-rejected");
    expect(shown.reason).toBe(`Anthropic did not accept Rovara's access for \`claude-haiku-5-5\` (the API key, or on Amazon Bedrock the worker role's model access). Fix the access, then retry the checks`);
    expect(shown.reason).toBe(E2E_OWNER_SENTENCES.agentCode("model-key-rejected", { providerLabel: "Anthropic", modelId: definition.modelId }));
    const everything = JSON.stringify({ outcome, verdict, shown });
    for (const text of HOSTILE) expect(everything, text).not.toContain(text);
    expect(everything).not.toContain(PROVIDER_KEY);
  });

  it("Bedrock's 429 with the error type header and a hostile message becomes the limit sentence, and nothing else", async () => {
    cleanRedirectingEnvironment();
    const definition = bedrockRoute();
    const loopback = await bedrockLoopback(() => ({ status: 429, body: JSON.stringify({ message: "Too many requests; the prompt echoed hunter2-echo sk-ant-SECRETVALUE" }),
      errorType: "ThrottlingException:http://internal.amazon.com/coral/com.amazon.bedrock/" }));
    try {
      const invoke = await createE2EProviderInvokeForTesting(definition, { environment: installationEnvironment(definition) }, { bedrockEndpoint: loopback.endpoint, providerEnv: { AWS_BEDROCK_SKIP_AUTH: "1" } });
      const outcome = await createGovernedE2EModelRoute(definition, { invoke, now: Date.now, dayBudget: createInMemoryE2EDayBudget() }).generate(channelRequest());
      expect(outcome.receipt.failure).toEqual({ class: "limit-or-rate-limited", signal: "ThrottlingException" });
      const verdict = evaluateE2EAgentCase(stopped("MODEL_PROVIDER_FAILED", [intoCase(outcome.receipt)]));
      expect(verdict.verdict).toEqual({ kind: "unknown", code: "model-limit-reached" });
      const shown = displayed(definition, "model-limit-reached");
      expect(shown.reason).toBe(`Amazon Bedrock refused the AI navigation call to \`us.anthropic.claude-haiku-5-5\`: this account's limit for that model is used up or set to zero. Raise the limit or choose another model, then retry the checks`);
      const everything = JSON.stringify({ outcome, verdict, shown });
      for (const text of HOSTILE) expect(everything, text).not.toContain(text);
    } finally { await loopback.close(); }
  });

  it("every sentence the model codes can show is one of the fixed ones (a snapshot of the whole set, for a Bedrock model)", () => {
    const ctx = { providerLabel: "Amazon Bedrock", modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0" };
    expect(E2E_AGENT_UNKNOWN_CODES.filter((code) => code.startsWith("model-")).map((code) => [code, E2E_OWNER_SENTENCES.agentCode(code, ctx)])).toMatchInlineSnapshot(`
      [
        [
          "model-receipts-mismatch",
          "The AI navigation record didn't match what was run, so this check can't be trusted; retry the checks",
        ],
        [
          "model-prompt-credential-match",
          "The AI navigator stopped because the page showed a test password, which the AI is never allowed to see; this check could not be decided",
        ],
        [
          "model-route-budget-exhausted",
          "The AI navigation budget for these checks ran out before they finished; retry the checks",
        ],
        [
          "model-limit-reached",
          "Amazon Bedrock refused the AI navigation call to \`us.anthropic.claude-haiku-4-5-20251001-v1:0\`: this account's limit for that model is used up or set to zero. Raise the limit or choose another model, then retry the checks",
        ],
        [
          "model-key-rejected",
          "Amazon Bedrock did not accept Rovara's access for \`us.anthropic.claude-haiku-4-5-20251001-v1:0\` (the API key, or on Amazon Bedrock the worker role's model access). Fix the access, then retry the checks",
        ],
        [
          "model-not-found",
          "Amazon Bedrock says \`us.anthropic.claude-haiku-4-5-20251001-v1:0\` does not exist or is not available to this account. Choose another model and approve setup again",
        ],
        [
          "model-unreachable",
          "Rovara could not reach Amazon Bedrock to call \`us.anthropic.claude-haiku-4-5-20251001-v1:0\`. Check the network path from the runner, then retry the checks",
        ],
        [
          "model-request-rejected",
          "Amazon Bedrock rejected the AI navigation request to \`us.anthropic.claude-haiku-4-5-20251001-v1:0\`, so this check could not run. Tell Rovara support (code model-request-rejected)",
        ],
        [
          "model-provider-outage",
          "Amazon Bedrock had a problem answering for \`us.anthropic.claude-haiku-4-5-20251001-v1:0\`. Retry the checks later",
        ],
        [
          "model-unavailable",
          "The AI model (Amazon Bedrock \`us.anthropic.claude-haiku-4-5-20251001-v1:0\`) couldn't be reached, so this AI-navigated check could not run; retry the checks",
        ],
      ]
    `);
  });
});
