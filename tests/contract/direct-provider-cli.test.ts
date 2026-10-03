// Spec 054: an administrator's own Anthropic or OpenAI API key, from init's questions to doctor.
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BEDROCK_MODELS, MissingProviderSecret } from "@agentx/model-runtime/config";
import { assertResumeFlagsMatch, collectInitAnswers, persistInitAnswers, storesOwnProviderKey, type InitFlags } from "../../packages/cli/src/init/answers.js";
import { estimateMonthlyCost, installPlanText } from "../../packages/cli/src/init/plan.js";
import { checkPrerequisites, directProviderCheck } from "../../packages/cli/src/init/prerequisites.js";
import { unattendedPrompter } from "../../packages/cli/src/init/prompts.js";
import { secretChecks } from "../../packages/cli/src/doctor/secrets.js";
import { doctorContext, doctorServices, SECRETS } from "../support/doctor-fakes.js";
import { fakeRelease, memoryInitSecrets, passingChecks, sampleAnswers, scriptedPrompter, settingsScript } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const base = { env: "staging", region: "us-east-1", account: "123456789012", releaseVersion: "1.2.3", processEnv: {}, now: () => T0 };
const ANTHROPIC_KEY = "sk-ant-api03-0123456789abcdefKEYSECRET";
const OPENAI_KEY = "sk-proj-0123456789abcdefKEYSECRET";
const everyFlag: InitFlags = {
  engine: "templates", identity: "cognito", permissionBoundary: "", operatorPrincipal: "", alertEmail: "ops@example.com", budget: "0",
  githubAccount: "acme", githubAccountType: "organization", githubAppName: "AgentX acme staging", slackAppName: "AgentX", slackAppPostedMessages: "accept",
};
const bedrockModels: InitFlags = { orchestratorModel: "us.anthropic.claude-sonnet-4-6", classifierModel: "amazon.nova-lite-v1:0", workerModel: "us.anthropic.claude-sonnet-4-6" };
/** Spec 048: the settings form answered as a run with these flags would answer it in the terminal. */
const collectWithFlags = (input: Omit<Parameters<typeof collectInitAnswers>[0], "prompter">) =>
  collectInitAnswers({ ...input, prompter: scriptedPrompter(settingsScript({ flags: input.flags })) });
const caller = { account: "123456789012", arn: "arn:aws:sts::123456789012:assumed-role/Admin/alice" };

function recordingSecrets(prompter: ReturnType<typeof scriptedPrompter>) {
  const hidden: string[] = [];
  return {
    hidden,
    prompter: { ...prompter, secret: async (question: string, options: { flag: string; multiline?: boolean }) => { hidden.push(question); return prompter.secret(question, options); } },
  };
}

describe("init with a direct provider", () => {
  // The settings form with Anthropic as the provider, then the three model ids (Enter for the
  // suggestions), the key, and whether the GitHub owner is an organization.
  const ANTHROPIC_RUN = [
    ...settingsScript({ owner: "acme", advanced: { modelProvider: "anthropic", alertEmail: "ops@example.com" } }),
    "", "", "", ANTHROPIC_KEY, "",
  ];

  it("choosing Anthropic suggests its models, asks for the key hidden, and stores only the secret's ARN in the answers", async () => {
    const scripted = scriptedPrompter(ANTHROPIC_RUN);
    const { prompter, hidden } = recordingSecrets(scripted);
    const collected = await collectInitAnswers({ ...base, flags: {}, prompter });
    expect(scripted.remaining()).toBe(0);
    const followUps = scripted.asked.slice(scripted.asked.indexOf("Anthropic orchestrator model id"), scripted.asked.indexOf("Anthropic API key") + 1);
    expect(followUps).toEqual(["Anthropic orchestrator model id", "Anthropic classifier model id", "Anthropic worker model id", "Anthropic API key"]);
    expect(hidden).toEqual(["Anthropic API key"]);
    expect(collected.answers.models).toEqual({
      orchestrator: "claude-sonnet-4-6", classifier: "claude-haiku-4-5", worker: "claude-sonnet-4-6",
      providers: { orchestrator: "anthropic", classifier: "anthropic", worker: "anthropic" },
    });
    expect(collected.directKeys).toEqual({ anthropic: ANTHROPIC_KEY });
    expect(JSON.stringify(collected.answers)).not.toContain(ANTHROPIC_KEY);

    const store = new MemoryParameterStore();
    const secrets = memoryInitSecrets();
    const saved = await persistInitAnswers({ store, secrets, collected });
    expect(secrets.values.get("agentx/staging/anthropic")).toBe(ANTHROPIC_KEY);
    expect(saved.models.anthropic).toEqual({ secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/anthropic-AbCdEf" });
    expect(storesOwnProviderKey(saved, "anthropic")).toBe(true);
    expect([...store.values.values()].join("\n")).not.toContain(ANTHROPIC_KEY);
  });

  it("mixes providers from flags, asking only for the key a role uses", async () => {
    const flags: InitFlags = { ...everyFlag, ...bedrockModels, workerProvider: "openai", workerModel: "gpt-5.4", openaiKey: { envName: "OPENAI_KEY" } };
    const collected = await collectWithFlags({ ...base, processEnv: { OPENAI_KEY: OPENAI_KEY }, flags });
    expect(collected.answers.models.providers).toEqual({ orchestrator: "amazon-bedrock", classifier: "amazon-bedrock", worker: "openai" });
    expect(collected.answers.models.orchestrator).toBe(DEFAULT_BEDROCK_MODELS.orchestrator);
    expect(collected.directKeys).toEqual({ openai: OPENAI_KEY });
    const saved = await persistInitAnswers({ store: new MemoryParameterStore(), secrets: memoryInitSecrets(), collected });
    expect(saved.models.openai?.secretArn).toMatch(/:secret:agentx\/staging\/openai-/);
    expect(saved.models.anthropic).toBeUndefined();
  });

  it("stores a key whose flag is given even when no role uses the provider, so projects can approve its models", async () => {
    const collected = await collectWithFlags({ ...base, processEnv: { KEY: ANTHROPIC_KEY }, flags: { ...everyFlag, ...bedrockModels, anthropicKey: { envName: "KEY" } } });
    expect(collected.answers.models.providers).toBeUndefined();
    expect(collected.directKeys).toEqual({ anthropic: ANTHROPIC_KEY });
  });

  it("with --anthropic-secret-arn, asks for no key and stores nothing", async () => {
    const secretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:team/anthropic-AbCdEf";
    const collected = await collectInitAnswers({ ...base, flags: { ...everyFlag, modelProvider: "anthropic", anthropicSecretArn: secretArn }, prompter: unattendedPrompter() });
    expect(collected.answers.models.anthropic).toEqual({ secretArn });
    expect(collected.directKeys).toBeUndefined();
    const secrets = memoryInitSecrets();
    await persistInitAnswers({ store: new MemoryParameterStore(), secrets, collected });
    expect(secrets.values.size).toBe(0);
    expect(storesOwnProviderKey(collected.answers, "anthropic")).toBe(false);
    await expect(collectInitAnswers({ ...base, flags: { ...everyFlag, anthropicSecretArn: secretArn, anthropicKey: { envName: "KEY" } }, prompter: unattendedPrompter() }))
      .rejects.toThrow("--anthropic-secret-arn names a secret you made yourself");
  });

  it("with --yes and no key source, refuses before anything is created, naming the flags", async () => {
    const refusal = collectInitAnswers({ ...base, flags: { ...everyFlag, modelProvider: "openai" }, prompter: unattendedPrompter() });
    await expect(refusal).rejects.toThrow("--openai-key-file <path> or --openai-key-env <NAME>");
    await expect(collectInitAnswers({ ...base, flags: { ...everyFlag, modelProvider: "openai" }, prompter: unattendedPrompter() })).rejects.toThrow("--openai-secret-arn");
  });

  it.each([
    ["anthropic", "sk-or-v1-0123456789abcdef", "starts with sk-ant-"],
    ["anthropic", "sk-ant-oat01-0123456789abcdef", "subscription token"],
    ["openai", "sk-or-v1-0123456789abcdef", "OpenRouter key"],
    ["openai", "sk-ant-api03-0123456789abcdef", "Anthropic key"],
    ["openai", "sk-1", "too short"],
  ] as const)("refuses a %s key %s without repeating it", async (provider, key, problem) => {
    const flags: InitFlags = { ...everyFlag, orchestratorModel: "m", classifierModel: "m", workerModel: "m", modelProvider: provider, [provider === "anthropic" ? "anthropicKey" : "openaiKey"]: { envName: "KEY" } };
    const error = await collectWithFlags({ ...base, processEnv: { KEY: key }, flags }).then(() => undefined, (caught: unknown) => caught as Error);
    expect(error?.message).toContain(problem);
    expect(error?.message).not.toContain(key);
  });

  it("refuses an unknown provider", async () => {
    await expect(collectWithFlags({ ...base, flags: { ...everyFlag, workerProvider: "gemini" } })).rejects.toThrow("model providers must be one of");
  });

  it("on a resume, a key flag replaces only a key init stored, and a secret ARN flag must match", async () => {
    const collected = await collectInitAnswers({ ...base, flags: {}, prompter: scriptedPrompter(ANTHROPIC_RUN) });
    const saved = await persistInitAnswers({ store: new MemoryParameterStore(), secrets: memoryInitSecrets(), collected });
    expect(() => assertResumeFlagsMatch(saved, { anthropicKey: { file: "/keys/anthropic" } })).not.toThrow();
    expect(() => assertResumeFlagsMatch(saved, { openaiKey: { file: "/keys/openai" } })).toThrow("--openai-key-file /keys/openai differs");
    expect(() => assertResumeFlagsMatch(saved, { modelProvider: "anthropic" })).not.toThrow();
    expect(() => assertResumeFlagsMatch(saved, { anthropicSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:other-AbCdEf" })).toThrow("--anthropic-secret-arn");
  });
});

describe("the install plan with a direct provider", () => {
  const anthropicModels = {
    orchestrator: "claude-sonnet-4-6", classifier: "claude-haiku-4-5", worker: "claude-sonnet-4-6",
    providers: { orchestrator: "anthropic", classifier: "anthropic", worker: "anthropic" },
  } as const;

  it("lists the secret init stores, and prices every role from the catalog's list price", () => {
    const answers = sampleAnswers({ models: anthropicModels });
    const estimate = estimateMonthlyCost(answers.models);
    expect(estimate.unpriced).toEqual([]);
    const orchestrator = estimate.lines.find((line) => line.item === "Main model (Claude Sonnet 4.6)");
    // 7,000 input and 300 output tokens a turn at $3 and $15 per million: the evaluated $0.025.
    expect(orchestrator).toMatchObject({ usd: 25, basis: "1,000 turns at about $0.025 each, Anthropic list price" });
    expect(estimate.lines.find((line) => line.item === "Coding model (Claude Sonnet 4.6)")).toMatchObject({ usd: 75, basis: "100 coding sessions at about $0.75 each, Anthropic list price" });
    const text = installPlanText(answers, estimate, [], { storesProviderKeys: ["anthropic"] });
    expect(text).toContain("agentx/staging/slack, agentx/staging/anthropic");
    expect(text).toContain("- Anthropic: your API key is stored in the new secret agentx/staging/anthropic");
  });

  it("names a model the catalog does not price instead of guessing, and only reads a secret you made yourself", () => {
    const answers = sampleAnswers({ models: { ...anthropicModels, worker: "claude-unknown", anthropic: { secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:mine-AbCdEf" } } });
    const estimate = estimateMonthlyCost(answers.models);
    expect(estimate.unpriced).toEqual(["claude-unknown"]);
    const text = installPlanText(answers, estimate, []);
    expect(text).not.toContain("agentx/staging/anthropic");
    expect(text).toContain("- Anthropic: read existing secret arn:aws:secretsmanager:us-east-1:123456789012:secret:mine-AbCdEf");
  });
});

describe("prerequisites with a direct provider", () => {
  async function run(answers: ReturnType<typeof sampleAnswers>, checks: ReturnType<typeof passingChecks>, directKeys?: { anthropic?: string; openai?: string }) {
    const lines: string[] = [];
    await checkPrerequisites({ answers, release: fakeRelease(), caller, checks, prompter: scriptedPrompter([]), write: (line) => lines.push(line), ...(directKeys === undefined ? {} : { directKeys }) });
    return lines;
  }
  const models = { orchestrator: "claude-sonnet-4-6", classifier: "claude-haiku-4-5", worker: "gpt-5.4", providers: { orchestrator: "anthropic", classifier: "anthropic", worker: "openai" } } as const;

  it("checks each direct model with the key init collected, and never calls Bedrock for those roles", async () => {
    const directProvider = vi.fn(async () => {});
    const checks = passingChecks({ directProvider });
    const lines = await run(sampleAnswers({ models }), checks, { anthropic: ANTHROPIC_KEY, openai: OPENAI_KEY });
    expect(directProvider.mock.calls).toEqual([
      ["anthropic", "claude-sonnet-4-6", {}, ANTHROPIC_KEY],
      ["anthropic", "claude-haiku-4-5", {}, ANTHROPIC_KEY],
      ["openai", "gpt-5.4", {}, OPENAI_KEY],
    ]);
    expect(checks.models).toEqual([]);
    expect(lines.join("\n")).toContain("ok openai/gpt-5.4 supports tools and answers");
    expect(lines.join("\n")).not.toContain(OPENAI_KEY);
  });

  it("checks the Bedrock default when a role's key is missing, and reports a refused key as a problem", async () => {
    const missing = passingChecks({ directProvider: async (provider) => { throw new MissingProviderSecret(provider); } });
    const lines = await run(sampleAnswers({ models: { ...models, anthropic: { secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:a-AbCdEf" }, openai: { secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:o-AbCdEf" } } }), missing);
    expect(missing.models).toContain(DEFAULT_BEDROCK_MODELS.worker);
    expect(lines.join("\n")).toContain("OpenAI secret missing; using default amazon-bedrock/");

    const refused = passingChecks({ directProvider: async () => { throw new Error("the API key was refused; check it, and that it may use this model"); } });
    await expect(run(sampleAnswers({ models }), refused, { anthropic: ANTHROPIC_KEY, openai: OPENAI_KEY })).rejects.toThrow("anthropic/claude-sonnet-4-6: Anthropic preflight failed: the API key was refused");
  });

  it.each(["anthropic", "openai"] as const)("sends one %s model lookup and one small tool-carrying request, reading the status not the body", async (provider) => {
    const requests: Array<{ url: string; headers: Headers; body?: Record<string, unknown> }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      requests.push({ url: String(url instanceof Request ? url.url : url), headers: new Headers(init?.headers), ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}) });
      if (requests.length === 1) return Response.json({ id: "model" });
      return Response.json(provider === "anthropic" ? { content: [{ type: "text", text: "OK" }] } : { status: "incomplete", output: [] });
    });
    const key = provider === "anthropic" ? ANTHROPIC_KEY : OPENAI_KEY;
    const modelId = provider === "anthropic" ? "claude-haiku-4-5" : "gpt-5.4-mini";
    await directProviderCheck({ provider, modelId, key, fetch, signal: new AbortController().signal });
    expect(requests.map((request) => request.url)).toEqual(provider === "anthropic"
      ? ["https://api.anthropic.com/v1/models/claude-haiku-4-5", "https://api.anthropic.com/v1/messages"]
      : ["https://api.openai.com/v1/models/gpt-5.4-mini", "https://api.openai.com/v1/responses"]);
    if (provider === "anthropic") expect(requests[1]!.headers.get("x-api-key")).toBe(key);
    else expect(requests[1]!.headers.get("authorization")).toBe(`Bearer ${key}`);
    expect(requests[1]!.body).toMatchObject(provider === "anthropic" ? { max_tokens: 16 } : { max_output_tokens: 16, store: false });
    expect(JSON.stringify(requests[1]!.body)).toContain("ping");

    const refusal = vi.fn<typeof globalThis.fetch>(async () => Response.json({ error: { message: `bad key ${key}` } }, { status: 401 }));
    const error = await directProviderCheck({ provider, modelId, key, fetch: refusal, signal: new AbortController().signal }).then(() => undefined, (caught: unknown) => caught as Error);
    expect(error?.message).toBe("the API key was refused; check it, and that it may use this model");
    const unavailable = vi.fn<typeof globalThis.fetch>(async () => new Response("", { status: 404 }));
    await expect(directProviderCheck({ provider, modelId, key, fetch: unavailable, signal: new AbortController().signal })).rejects.toThrow("not available to this key's organization");
  });
});

describe("doctor: direct provider secrets", () => {
  const withKey = (provider: "anthropic" | "openai", secretArn: string, secrets: Record<string, string> = SECRETS) => doctorContext({
    settings: { ...doctorContext().settings, models: { ...doctorContext().settings.models, [provider]: { secretArn } } },
    services: doctorServices({ secrets: memoryInitSecrets(secrets) }),
  });

  it("reports init's own key ok, the wrong kind of key as a problem, and never shows the value", async () => {
    const arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/anthropic-AbCdEf";
    const ok = await secretChecks(withKey("anthropic", arn, { ...SECRETS, "agentx/staging/anthropic": ANTHROPIC_KEY }));
    expect(ok.find((entry) => entry.name === "agentx/staging/anthropic")).toMatchObject({ status: "ok" });
    const wrong = await secretChecks(withKey("anthropic", arn, { ...SECRETS, "agentx/staging/anthropic": OPENAI_KEY }));
    expect(wrong.find((entry) => entry.name === "agentx/staging/anthropic")).toMatchObject({ status: "fail", detail: "an Anthropic API key starts with sk-ant-" });
    expect(JSON.stringify([ok, wrong])).not.toContain("KEYSECRET");
  });

  it("skips a key in a secret the operator made", async () => {
    const arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:team/openai-AbCdEf";
    const checks = await secretChecks(withKey("openai", arn));
    expect(checks.find((entry) => entry.name === "OpenAI key")).toMatchObject({ status: "skip" });
    expect(checks.find((entry) => entry.name === "agentx/staging/openai")).toBeUndefined();
  });
});
