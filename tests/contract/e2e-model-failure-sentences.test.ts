import { describe, expect, it } from "vitest";
import { E2E_AGENT_UNKNOWN_CODES } from "@agentx/verifier";
import { E2E_OWNER_SENTENCES, modelSentenceContext } from "../../packages/broker/src/e2e/owner-sentences.js";
import { buildScenarioRows, scrubScenarioResults, type DisplayGroupInput } from "../../packages/broker/src/e2e/application-display.js";
import { results, row } from "../support/e2e-scenario-results.js";

// M1.4 Task 4.10B, tests 22 and 23: the owner's sentences for each failure class name the provider and the model, from the broker's stored definition only.
const CTX = { providerLabel: "Amazon Bedrock", modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0" };
const M = "`us.anthropic.claude-haiku-4-5-20251001-v1:0`";
const MODEL_CODES = ["model-limit-reached", "model-key-rejected", "model-not-found", "model-unreachable", "model-request-rejected", "model-provider-outage", "model-secret-unreadable", "model-not-in-catalog", "model-unavailable"] as const;

describe("22. the sentence of each model code, from the approved wording", () => {
  it("gives exactly the approved text for each code with the provider and the model named", () => {
    const say = (code: (typeof MODEL_CODES)[number]) => E2E_OWNER_SENTENCES.agentCode(code, CTX);
    expect(say("model-limit-reached")).toBe(`Amazon Bedrock refused the AI navigation call to ${M}: this account's limit for that model is used up or set to zero. Raise the limit, or choose another model and run its driving test (agentx project model-check test --model <id>), then retry the checks`);
    expect(say("model-key-rejected")).toBe(`Amazon Bedrock did not accept Rovara's access for ${M} (the API key, or on Amazon Bedrock the worker role's model access). Fix the access, then retry the checks`);
    expect(say("model-not-found")).toBe(`Amazon Bedrock says ${M} does not exist or is not available to this account. Choose another model, run its driving test (agentx project model-check test --model <id>), and approve setup again`);
    expect(say("model-unreachable")).toBe(`Rovara could not reach Amazon Bedrock to call ${M}. Check the network path from the runner, then retry the checks`);
    expect(say("model-request-rejected")).toBe(`Amazon Bedrock rejected the AI navigation request to ${M}, so this check could not run. Tell Rovara support (code model-request-rejected)`);
    expect(say("model-provider-outage")).toBe(`Amazon Bedrock had a problem answering for ${M}. Retry the checks later`);
    expect(say("model-secret-unreadable")).toBe("Rovara could not read its stored access for Amazon Bedrock. Check that the key's secret exists and Rovara's worker can read it, then retry the checks");
    expect(say("model-not-in-catalog")).toBe(`Rovara doesn't know how to call ${M} on Amazon Bedrock. Choose a model from the list Rovara offers`);
    expect(say("model-unavailable")).toBe(`The AI model (Amazon Bedrock ${M}) couldn't be reached, so this AI-navigated check could not run; retry the checks`);
  });

  it("names the provider that was configured, whichever it is", () => {
    for (const providerLabel of ["Anthropic", "OpenAI", "OpenRouter"]) {
      expect(E2E_OWNER_SENTENCES.agentCode("model-limit-reached", { providerLabel, modelId: "m1" })).toContain(`${providerLabel} refused the AI navigation call to \`m1\``);
      expect(E2E_OWNER_SENTENCES.agentCode("model-unreachable", { providerLabel, modelId: "m1" })).toContain(`could not reach ${providerLabel} to call`);
    }
  });

  it("quotes a model id safely: a quote, a semicolon, a backtick, control and direction characters cannot close the quotation or read as another claim", () => {
    const hostile = "a;b'c\"d`e\u202Efg\nh\u0000i";
    for (const code of MODEL_CODES) {
      const sentence = E2E_OWNER_SENTENCES.agentCode(code, { providerLabel: "Amazon Bedrock", modelId: hostile });
      // The unreadable-secret sentence, as approved, names the provider only.
      if (code !== "model-secret-unreadable") { expect(sentence, code).toContain("a,b’c”d’e fg h i"); expect(sentence.split("`").length - 1, code).toBe(2); }
      for (const character of ["\u202E", "\u0000", "\n", '"']) expect(sentence, code).not.toContain(character);
      // The only semicolon allowed is the approved one in the model-unavailable sentence's own wording.
      expect(sentence.split(";").length - 1, code).toBe(code === "model-unavailable" ? 1 : 0);
    }
  });

  it("cuts a very long model id and a long provider label, so a sentence always fits a row's 300 characters", () => {
    for (const code of MODEL_CODES) {
      const sentence = E2E_OWNER_SENTENCES.agentCode(code, { providerLabel: "Amazon Bedrock", modelId: "x".repeat(200) });
      expect(sentence.length, code).toBeLessThanOrEqual(300);
      if (code !== "model-secret-unreadable") expect(sentence, code).toContain("…");
    }
    // A long provider label is cut too, whatever the sentence.
    for (const code of MODEL_CODES) expect(E2E_OWNER_SENTENCES.agentCode(code, { providerLabel: "P".repeat(300), modelId: "x".repeat(300) }).length, code).toBeLessThanOrEqual(300);
  });

  it("without a stored definition (none was read) the sentences name no provider and no model, and model-unavailable is exactly the sentence it was before", () => {
    expect(E2E_OWNER_SENTENCES.agentCode("model-unavailable", undefined)).toBe("The AI model couldn't be reached, so this AI-navigated check could not run; retry the checks");
    for (const code of MODEL_CODES) {
      const sentence = E2E_OWNER_SENTENCES.agentCode(code, undefined);
      expect(sentence, code).not.toContain("`");
      // The key sentence's approved wording names Amazon Bedrock's role access in its own words; no other sentence names a provider without a definition.
      if (code !== "model-key-rejected") expect(sentence, code).not.toContain("Amazon");
    }
    const all = MODEL_CODES.map((code) => E2E_OWNER_SENTENCES.agentCode(code, undefined));
    expect(new Set(all).size).toBe(all.length);
  });

  it("leaves the other agent codes as they were, whatever the context", () => {
    for (const code of E2E_AGENT_UNKNOWN_CODES.filter((item) => !(MODEL_CODES as readonly string[]).includes(item))) {
      expect(E2E_OWNER_SENTENCES.agentCode(code, CTX), code).toBe(E2E_OWNER_SENTENCES.agentCode(code, undefined));
    }
    expect(E2E_OWNER_SENTENCES.agentCode("model-route-budget-exhausted", CTX)).toBe("The AI navigation budget for these checks ran out before they finished; retry the checks");
    expect(E2E_OWNER_SENTENCES.agentCode("agent-no-download", CTX)).toBe("The AI navigator didn't find a way to download the CSV; retry, or check the button exists");
  });

  it("has a sentence for every code, all different from each other", () => {
    const all = E2E_AGENT_UNKNOWN_CODES.map((code) => E2E_OWNER_SENTENCES.agentCode(code, CTX));
    expect(all.every((sentence) => sentence.length > 0)).toBe(true);
    expect(new Set(all).size).toBe(E2E_AGENT_UNKNOWN_CODES.length);
  });

  it("the new group code says the driving test has not passed, in the approved words", () => {
    expect(E2E_OWNER_SENTENCES.groupCode["model-route-not-tested"]).toBe("AI navigation has not passed its driving test yet. Run the driving test, then approve setup again.");
  });

  it("carries RUN-3's runtime-expired group sentence, so a group refused for it does not read 'could not be verified'", () => {
    expect(E2E_OWNER_SENTENCES.groupCode["runtime-expired"]).toBe("The browser and API runtime's qualification expired. An administrator must qualify it again, then retry the checks.");
  });

  it("the context comes from a stored route definition: the provider's name and the pinned model, and nothing for a scripted route", () => {
    expect(modelSentenceContext({ provider: "amazon-bedrock", modelId: "us.anthropic.claude-haiku-5-5" })).toEqual({ providerLabel: "Amazon Bedrock", modelId: "us.anthropic.claude-haiku-5-5" });
    expect(modelSentenceContext({ provider: "anthropic", modelId: "claude-haiku-5-5" })?.providerLabel).toBe("Anthropic");
    expect(modelSentenceContext({ provider: "openai", modelId: "gpt-5.4-mini" })?.providerLabel).toBe("OpenAI");
    expect(modelSentenceContext({ provider: "openrouter", modelId: "anthropic/claude-haiku-5.5" })?.providerLabel).toBe("OpenRouter");
    expect(modelSentenceContext({ provider: "rovara-scripted", modelId: "scripted" })).toBeUndefined();
    expect(modelSentenceContext(null)).toBeUndefined();
    expect(modelSentenceContext(undefined)).toBeUndefined();
  });
});

describe("22. the rows the page shows", () => {
  const caseOf = { caseId: "owner-export-ai-case", scenarioId: "owner-export-ai", targetId: "web-1", accountProfileId: "orders-owner" };
  const group = (overrides: Partial<DisplayGroupInput> = {}): DisplayGroupInput => ({ verdict: "UNKNOWN", reason: "", cases: [caseOf], scenarios: new Map(), result: undefined, observed: new Map(), screenshots: new Map(), ...overrides });
  const rowsOf = (groups: DisplayGroupInput[]) => buildScenarioRows({ authoritative: true, attach: "failed-or-incomplete", targetKinds: new Map([["web-1", "web"]]), groups }).scenarios;
  const unavailableCase = (reason: string) => ({ cases: [{ caseId: caseOf.caseId, status: "unavailable", reason, assertionReceipts: [{ assertionIndex: 0, status: "unavailable" }] }] });

  it("a case that stopped for a model code shows the sentence naming the group's stored provider and model", () => {
    for (const code of MODEL_CODES) {
      const [shown] = rowsOf([group({ result: unavailableCase(code), model: CTX })]);
      expect(shown!.status).toBe("UNKNOWN");
      expect(shown!.reason, code).toBe(E2E_OWNER_SENTENCES.agentCode(code, CTX));
    }
  });

  it("a group refused whole with a model code is put into the same words", () => {
    const [shown] = rowsOf([group({ reason: "model-limit-reached: the provider said something with hunter2-echo in it", model: CTX })]);
    expect(shown!.reason).toBe(E2E_OWNER_SENTENCES.agentCode("model-limit-reached", CTX));
    expect(JSON.stringify(shown)).not.toContain("hunter2-echo");
  });

  it("with no model on the group the row still says why, without a provider", () => {
    const [shown] = rowsOf([group({ result: unavailableCase("model-key-rejected") })]);
    expect(shown!.reason).toBe(E2E_OWNER_SENTENCES.agentCode("model-key-rejected", undefined));
  });

  it("says model-route-not-tested for a group refused for it, and repeats nothing after the code", () => {
    const [shown] = rowsOf([group({ reason: "model-route-not-tested: password=hunter2-secret" })]);
    expect(shown!.reason).toBe("AI navigation has not passed its driving test yet. Run the driving test, then approve setup again.");
  });

  it("an old v3 row, written with the sentence the code gave before 4.10, still passes the display schema unchanged", () => {
    const old = "The AI model couldn't be reached, so this AI-navigated check could not run; retry the checks";
    const stored = results({ scenarios: [row({ status: "UNKNOWN", reason: old })] });
    const scrubbed = scrubScenarioResults(stored);
    expect(scrubbed).toBeDefined();
    expect(scrubbed!.scenarios[0]!.reason).toBe(old);
  });

  it("every sentence a row can show fits the schema's 300 characters even for the longest id the route allows", () => {
    for (const code of MODEL_CODES) {
      const [shown] = rowsOf([group({ result: unavailableCase(code), model: { providerLabel: "Amazon Bedrock", modelId: "y".repeat(200) } })]);
      expect(scrubScenarioResults(results({ scenarios: [shown!] })), code).toBeDefined();
    }
  });
});
