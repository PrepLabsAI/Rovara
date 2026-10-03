import { describe, expect, it } from "vitest";
import {
  alertWebhookSecretName, assertResumeFlagsMatch, BUDGET_TAG_NOTE, collectInitAnswers, defaultAppName, GITHUB_APP_NAME_LIMIT, GLM_NOTE, HAIKU_NOTE, persistInitAnswers, type InitFlags,
} from "../../packages/cli/src/init/answers.js";
import { readInstallAnswers } from "../../packages/cli/src/init/install-state.js";
import { estimateMonthlyCost, suggestedBudgetUsd } from "../../packages/cli/src/init/cost.js";
import { unattendedPrompter } from "../../packages/cli/src/init/prompts.js";
import { GITHUB_LOGIN_PATTERN } from "../../packages/cli/src/deploy/answer-schemas.js";
import { SecretAlreadyExistsError } from "../../packages/cli/src/deploy/signing-key.js";
import { memoryInitSecrets, sampleAnswers, scriptedPrompter, settingsScript } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const T0 = Date.parse("2026-09-27T00:00:00.000Z");
const WEBHOOK = "https://api.opsgenie.com/v1/json/amazonsns?apiKey=0f9e8d7c-SECRET-KEY-6b5a";
const base = { env: "staging", region: "us-east-1", account: "123456789012", releaseVersion: "1.2.3", processEnv: {}, now: () => T0 };

const everyFlag: InitFlags = {
  engine: "templates", identity: "cognito",
  orchestratorModel: "us.anthropic.claude-sonnet-4-6", classifierModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0", workerModel: "us.anthropic.claude-sonnet-4-6",
  permissionBoundary: "", operatorPrincipal: "",
  alertEmail: "ops@example.com",
  budget: "0",
  githubAccount: "acme", githubAccountType: "organization", githubAppName: "AgentX acme (staging)",
  slackAppName: "AgentX acme (staging)", slackAppPostedMessages: "accept",
};

// Spec 048 FR-020: the settings form's questions in the terminal, in its own order: the four, the
// Advanced question, then (on yes) every Advanced setting.
const FORM_QUESTIONS = [
  "Your email, for your AgentX admin user and alerts", "GitHub organization or user that will own the AgentX GitHub App", "Install name",
  "App name for GitHub and Slack (unique on GitHub)", "Change the advanced settings?",
  "Deploy engine", "Sign-in", "How will developers sign in to AgentX from their AI tools?", "Model provider", "Orchestrator model",
  "Action-gate classifier model", "Worker model", "Permission boundary policy ARN (Enter for AgentX's default boundary)",
  "IAM principal allowed to assume the AgentX operator role (Enter for this account)", "Monthly AWS budget for this environment, in US dollars (0 for none; empty for the estimate plus 20%, $260)",
  "Which costs should the budget count?", "Answer mentions people post through other apps with their own Slack token?", "Where should AgentX send alerts?", "Alert email address",
];
// Every default taken but alerts to the ops address, then "" for the owner's type (no GitHub lookup here).
const FIRST_RUN = [...settingsScript({ owner: "acme", advanced: { alertEmail: "ops@example.com" } }), ""];

/** Spec 048 phase 2: collectInitAnswers with the settings form answered as a run with these flags
 * answers it in the terminal: each default-path field the flags leave (Enter takes its default),
 * and no to the Advanced settings. */
const collectWithFlags = (input: Omit<Parameters<typeof collectInitAnswers>[0], "prompter">) =>
  collectInitAnswers({ ...input, prompter: scriptedPrompter(settingsScript({ flags: input.flags })) });

function memoryAlertSecrets() {
  const values = new Map<string, string>();
  return {
    values,
    async create(name: string, value: string) { if (values.has(name)) throw new SecretAlreadyExistsError(name); values.set(name, value); },
    async put(name: string, value: string) { values.set(name, value); },
  };
}

describe("init questions", () => {
  it("collects mixed providers and only a secret reference, and protects resumed answers", async () => {
    const secretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:openrouter-AbCdEf";
    const flags = { ...everyFlag, workerProvider: "openrouter", workerModel: "anthropic/claude-sonnet-4", openrouterSecretArn: secretArn, openrouterProviders: "anthropic" };
    const { answers } = await collectWithFlags({ ...base, flags });
    expect(answers.models.providers).toEqual({ orchestrator: "amazon-bedrock", classifier: "amazon-bedrock", worker: "openrouter" });
    expect(answers.models.openRouter).toEqual({ secretArn, providers: ["anthropic"] });
    expect(() => assertResumeFlagsMatch(answers, { workerProvider: "amazon-bedrock" })).toThrow();
    await expect(collectWithFlags({ ...base, flags: { ...flags, openrouterSecretArn: "sk-raw-secret" } })).rejects.toThrow("invalid model configuration");
  });
  it("takes every default with Enter and asks for what has no default", async () => {
    const prompter = scriptedPrompter(FIRST_RUN);
    const { answers, notes, alertWebhook } = await collectInitAnswers({ ...base, flags: {}, prompter });
    expect(prompter.remaining()).toBe(0);
    expect(prompter.asked).toEqual([...FORM_QUESTIONS, "Is acme an organization or a personal account?"]);
    expect(alertWebhook).toBeUndefined();
    expect(notes).toEqual([HAIKU_NOTE]);
    expect(answers).toEqual({
      schemaVersion: 1, env: "staging", region: "us-east-1", account: "123456789012", engine: "templates", releaseVersion: "1.2.3",
      identity: { mode: "cognito" },
      models: { orchestrator: "us.anthropic.claude-sonnet-4-6", classifier: "us.anthropic.claude-haiku-4-5-20251001-v1:0", worker: "us.anthropic.claude-sonnet-4-6" },
      alert: { kind: "email", address: "ops@example.com" },
      budget: { monthlyUsd: 260, scope: "account" },
      github: { account: "acme", accountType: "organization", appName: "AgentX acme (staging)" },
      slack: { appName: "AgentX acme (staging)", appPostedMessages: "accept" },
      // Spec 048 FR-020: your email and the developer sign-in are settings now.
      adminEmail: "ops@example.com", signinMethods: "slack",
      createdAt: "2026-09-27T00:00:00.000Z",
    });
  });

  it("spec 048 FR-023: the budget's default is the estimate plus 20% for the whole account, with the estimate beside it", async () => {
    const asked: Array<{ question: string; defaultValue?: string; why?: string; hint?: string }> = [];
    const prompter = scriptedPrompter(FIRST_RUN);
    const recording = { ...prompter, ask: (question: string, options: Parameters<typeof prompter.ask>[1]) => { asked.push({ question, ...(options.defaultValue === undefined ? {} : { defaultValue: options.defaultValue }), ...(options.help?.why === undefined ? {} : { why: options.help.why }), ...(options.help?.hint === undefined ? {} : { hint: options.help.hint }) }); return prompter.ask(question, options); } };
    const collected = await collectInitAnswers({ env: "staging", region: "us-east-1", account: "123456789012", releaseVersion: "1.2.3", flags: {}, prompter: recording, processEnv: {}, now: () => 0 });
    expect(collected.answers.budget).toEqual({ monthlyUsd: 260, scope: "account" });
    expect(asked.find((entry) => entry.question.startsWith("Monthly AWS budget"))).toEqual({
      // Spec 048 FR-023: empty is the estimate of the models chosen, plus 20%, so the field's own default is
      // empty; the suggested amount is in the terminal's question and the page's hint.
      question: "Monthly AWS budget for this environment, in US dollars (0 for none; empty for the estimate plus 20%, $260)", defaultValue: "",
      why: "AgentX's estimate is about $211.13 a month. The suggested budget is the estimate plus 20%. AWS emails you when this month's costs pass 80% of it. 0 turns it off.",
      hint: "Optional. Leave empty to use the estimate plus 20% ($260).",
    });
    expect(collected.notes).not.toContain(BUDGET_TAG_NOTE);
  });

  it("asks only the install name and the Advanced question when every flag is given", async () => {
    const prompter = scriptedPrompter(settingsScript({ flags: everyFlag }));
    const { answers } = await collectInitAnswers({ ...base, flags: everyFlag, prompter });
    expect(prompter.asked).toEqual(["Install name", "Change the advanced settings?"]);
    expect(answers.github.appName).toBe("AgentX acme (staging)");
  });

  it("states GLM 4.7's trade-off and Claude Haiku 4.5's model-access need when chosen", async () => {
    const { answers, notes } = await collectWithFlags({ ...base, flags: { ...everyFlag, orchestratorModel: "zai.glm-4.7", classifierModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0" } });
    expect(answers.models.orchestrator).toBe("zai.glm-4.7");
    expect(notes).toEqual([GLM_NOTE, HAIKU_NOTE]);
    expect(GLM_NOTE).toContain("6 of 7");
  });

  it("accepts another Bedrock model id for the orchestrator", async () => {
    const flags = { ...everyFlag, orchestratorModel: undefined } as InitFlags;
    const prompter = scriptedPrompter([...settingsScript({ flags, advanced: { orchestratorModel: "other" } }), "us.anthropic.claude-opus-4-1-20250805-v1:0"]);
    const { answers } = await collectInitAnswers({ ...base, flags, prompter });
    expect(prompter.asked.at(-1)).toBe("Orchestrator model id");
    expect(answers.models.orchestrator).toBe("us.anthropic.claude-opus-4-1-20250805-v1:0");
  });

  it("collects your own OIDC provider's issuer, audience, client and admin claim", async () => {
    const flags: InitFlags = { ...everyFlag, identity: "oidc", oidcIssuer: "https://id.example.com", oidcAudience: "agentx", oidcClientId: "cli", adminClaim: "groups", adminValues: "agentx-admins, platform" };
    const { answers } = await collectWithFlags({ ...base, flags });
    expect(answers.identity).toEqual({ mode: "oidc", issuer: "https://id.example.com", audience: "agentx", clientId: "cli", adminClaim: "groups", adminValues: ["agentx-admins", "platform"] });
  });

  it("keeps a webhook address out of the answers and stores it only as a secret (Review Focus 4)", async () => {
    const flags: InitFlags = { ...everyFlag, alertEmail: undefined } as InitFlags;
    const prompter = scriptedPrompter([...settingsScript({ flags, advanced: { alertKind: "webhook" } }), `  ${WEBHOOK}\r\n`]);
    const collected = await collectInitAnswers({ ...base, flags, prompter });
    expect(collected.answers.alert).toEqual({ kind: "webhook", display: "https://api.opsgenie.com/...", secretName: "agentx/staging/alert-endpoint" });
    expect(JSON.stringify(collected.answers)).not.toContain("SECRET-KEY");
    expect(collected.alertWebhook).toBe(WEBHOOK);

    const store = new MemoryParameterStore();
    const secrets = memoryAlertSecrets();
    await persistInitAnswers({ store, secrets, collected });
    expect(secrets.values.get(alertWebhookSecretName("staging"))).toBe(WEBHOOK);
    expect(store.values.get("/agentx/staging/install/answers")).not.toContain("SECRET-KEY");
    expect(await readInstallAnswers(store, "staging")).toEqual(collected.answers);
  });

  it("reads a webhook from --alert-webhook-env, refuses one that is not https, and replaces a secret left by an aborted run", async () => {
    const flags: InitFlags = { ...everyFlag, alertEmail: undefined, alertWebhook: { envName: "AGENTX_ALERT_WEBHOOK" } } as InitFlags;
    const collected = await collectWithFlags({ ...base, processEnv: { AGENTX_ALERT_WEBHOOK: WEBHOOK }, flags });
    const secrets = memoryAlertSecrets();
    secrets.values.set("agentx/staging/alert-endpoint", "https://stale.example.com/x");
    await persistInitAnswers({ store: new MemoryParameterStore(), secrets, collected });
    expect(secrets.values.get("agentx/staging/alert-endpoint")).toBe(WEBHOOK);

    let message = "";
    try {
      await collectWithFlags({ ...base, processEnv: { AGENTX_ALERT_WEBHOOK: "http://hooks.example.com/k=SECRET-KEY" }, flags });
    } catch (error) { message = (error as Error).message; }
    expect(message).toContain("an alert webhook must be an https:// address");
    expect(message).not.toContain("SECRET-KEY");
  });

  it("with --yes and no alert flag, refuses for want of your email, and sends alerts to --admin-email when given", async () => {
    const flags = { ...everyFlag, alertEmail: undefined } as InitFlags;
    // Spec 048 FR-025 (Ruling 9): alerts go to your email, so with neither flag your email is what is missing.
    await expect(collectInitAnswers({ ...base, flags, prompter: unattendedPrompter() }))
      .rejects.toThrow("Your email, for your AgentX admin user and alerts needs an answer; with --yes, pass --admin-email");
    const { answers } = await collectInitAnswers({ ...base, flags, prompter: unattendedPrompter(), adminEmail: "alice@example.com" });
    expect(answers.alert).toEqual({ kind: "email", address: "alice@example.com" });
  });

  it("records no alerts for --no-alerts, with a note saying nobody will hear about failures", async () => {
    const { answers, notes } = await collectWithFlags({ ...base, flags: { ...everyFlag, alertEmail: undefined, alerts: false } as InitFlags });
    expect(answers.alert).toEqual({ kind: "none" });
    expect(notes.join("\n")).toContain("nobody is told when AgentX fails");
  });

  it("refuses an --admin-email that is not an email address, naming the flag", async () => {
    await expect(collectWithFlags({ ...base, flags: everyFlag, adminEmail: "not-an-email" }))
      .rejects.toThrow("--admin-email not-an-email is not an email address");
  });

  it("refuses an image override that is not a digest reference", async () => {
    await expect(collectWithFlags({ ...base, flags: { ...everyFlag, workerImage: "repo/worker:latest" } }))
      .rejects.toThrow("--worker-image must be referenced by digest (repository@sha256:...)");
  });

  it("with --yes and no GitHub account, names the flag", async () => {
    await expect(collectInitAnswers({ ...base, flags: { ...everyFlag, githubAccount: undefined } as InitFlags, prompter: unattendedPrompter() }))
      .rejects.toThrow("with --yes, pass --github-account");
  });

  it("shares the GitHub login pattern with install-state's schema (Fix round 1, item 1), refusing the same invalid login", async () => {
    expect(GITHUB_LOGIN_PATTERN.test("-bad")).toBe(false);
    await expect(collectWithFlags({ ...base, flags: { ...everyFlag, githubAccount: "-bad" } }))
      .rejects.toThrow("--github-account -bad is not a GitHub organization or user name");
  });
});

describe("the budget question (FR-047)", () => {
  it("defaults to the estimate plus 20% for the whole account, and only the tag choice needs it activated", async () => {
    const suggested = suggestedBudgetUsd(estimateMonthlyCost({ orchestrator: everyFlag.orchestratorModel!, classifier: everyFlag.classifierModel!, worker: everyFlag.workerModel! }));
    const result = await collectWithFlags({ ...base, flags: { ...everyFlag, budget: undefined } as InitFlags });
    expect(result.answers.budget).toEqual({ monthlyUsd: suggested, scope: "account" });
    expect(result.notes).not.toContain(BUDGET_TAG_NOTE);
  });

  it("takes --budget 0 as no budget, asking nothing", async () => {
    const result = await collectWithFlags({ ...base, flags: { ...everyFlag, budget: "0" } });
    expect(result.answers.budget).toBeUndefined();
  });

  it("takes --budget 250 --budget-scope account without the tag note", async () => {
    const result = await collectWithFlags({ ...base, flags: { ...everyFlag, budget: "250", budgetScope: "account" } });
    expect(result.answers.budget).toEqual({ monthlyUsd: 250, scope: "account" });
    expect(result.notes).not.toContain(BUDGET_TAG_NOTE);
  });

  it("refuses a budget that is not a whole number of dollars", async () => {
    await expect(collectWithFlags({ ...base, flags: { ...everyFlag, budget: "99.5" } }))
      .rejects.toThrow("--budget must be a whole number of US dollars from 1 to 1000000, or 0 for no budget");
  });

  it.each(["00", "-5", "12.5", "abc", "2000000"])("refuses a malformed or too-large budget (--budget %s), before the plan is shown", async (bad) => {
    await expect(collectWithFlags({ ...base, flags: { ...everyFlag, budget: bad } }))
      .rejects.toThrow("--budget must be a whole number of US dollars from 1 to 1000000, or 0 for no budget");
  });

  it("accepts the maximum budget of $1,000,000 (BudgetAnswersSchema's own max)", async () => {
    const result = await collectWithFlags({ ...base, flags: { ...everyFlag, budget: "1000000", budgetScope: "tag" } });
    expect(result.answers.budget).toEqual({ monthlyUsd: 1_000_000, scope: "tag" });
  });

  it("refuses a resume whose --budget differs from what the install started with", () => {
    expect(() => assertResumeFlagsMatch(sampleAnswers({ budget: { monthlyUsd: 100, scope: "tag" } }), { budget: "200" }))
      .toThrow("--budget 200 differs from what this install started with (100)");
  });
});

const OPENROUTER_KEY = "sk-or-v1-0123456789abcdefKEYSECRET";

/** Records which questions came through the hidden secret prompt. */
function recordingSecrets(prompter: ReturnType<typeof scriptedPrompter>) {
  const hidden: string[] = [];
  return {
    hidden,
    prompter: { ...prompter, secret: async (question: string, options: { flag: string; multiline?: boolean }) => { hidden.push(question); return prompter.secret(question, options); } },
  };
}

describe("OpenRouter from init", () => {
  // The settings with OpenRouter as the provider, then the three OpenRouter model ids, the key, and the owner's type.
  const OPENROUTER_RUN = [
    ...settingsScript({ owner: "acme", advanced: { modelProvider: "openrouter", alertEmail: "ops@example.com" } }),
    "qwen/qwen3-coder", "qwen/qwen3-coder", "anthropic/claude-sonnet-4", OPENROUTER_KEY, "",
  ];

  it("choosing OpenRouter asks the three model ids and the key (hidden), and stores the raw key as agentx/<env>/openrouter with only its ARN in the answers", async () => {
    const scripted = scriptedPrompter(OPENROUTER_RUN);
    const { prompter, hidden } = recordingSecrets(scripted);
    const collected = await collectInitAnswers({ ...base, flags: {}, prompter });
    expect(scripted.remaining()).toBe(0);
    expect(scripted.asked).toEqual([
      ...FORM_QUESTIONS, "OpenRouter orchestrator model id", "OpenRouter classifier model id", "OpenRouter worker model id", "OpenRouter API key",
      "Is acme an organization or a personal account?",
    ]);
    expect(hidden).toEqual(["OpenRouter API key"]);
    expect(collected.answers.models).toEqual({
      orchestrator: "qwen/qwen3-coder", classifier: "qwen/qwen3-coder", worker: "anthropic/claude-sonnet-4",
      providers: { orchestrator: "openrouter", classifier: "openrouter", worker: "openrouter" },
    });
    expect(JSON.stringify(collected.answers)).not.toContain(OPENROUTER_KEY);

    const store = new MemoryParameterStore();
    const secrets = memoryInitSecrets();
    const saved = await persistInitAnswers({ store, secrets, collected });
    expect(secrets.values.get("agentx/staging/openrouter")).toBe(OPENROUTER_KEY);
    expect(saved.models.openRouter).toEqual({ secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/openrouter-AbCdEf" });
    expect(await readInstallAnswers(store, "staging")).toEqual(saved);
    expect([...store.values.values()].join("\n")).not.toContain(OPENROUTER_KEY);
  });

  it("keeps an --openrouter-providers allowlist with a key init stores", async () => {
    const flags: InitFlags = { ...everyFlag, orchestratorModel: "a/b", classifierModel: "a/b", workerModel: "a/b", modelProvider: "openrouter", openrouterProviders: "deepinfra/turbo", openrouterKey: { envName: "OR_KEY" } };
    const collected = await collectWithFlags({ ...base, processEnv: { OR_KEY: OPENROUTER_KEY }, flags });
    const saved = await persistInitAnswers({ store: new MemoryParameterStore(), secrets: memoryInitSecrets(), collected });
    expect(saved.models.openRouter?.providers).toEqual(["deepinfra/turbo"]);
  });

  it("with --yes, reads the key from --openrouter-key-file, and without a key flag refuses, naming the flags", async () => {
    const flags: InitFlags = { ...everyFlag, orchestratorModel: "a/b", classifierModel: "a/b", workerModel: "a/b", modelProvider: "openrouter" };
    const collected = await collectInitAnswers({
      ...base, flags: { ...flags, openrouterKey: { file: "/keys/openrouter" } }, prompter: unattendedPrompter(),
      readFile: async (path) => { if (path !== "/keys/openrouter") throw new Error("unexpected path"); return `${OPENROUTER_KEY}\n`; },
    });
    expect(collected.openRouterKey).toBe(OPENROUTER_KEY);
    expect(collected.answers.models.providers).toEqual({ orchestrator: "openrouter", classifier: "openrouter", worker: "openrouter" });

    const refusal = collectInitAnswers({ ...base, flags, prompter: unattendedPrompter() });
    await expect(refusal).rejects.toThrow("--openrouter-key-file <path> or --openrouter-key-env <NAME>");
    await expect(collectInitAnswers({ ...base, flags, prompter: unattendedPrompter() })).rejects.toThrow("--openrouter-secret-arn");
  });

  it("with --openrouter-secret-arn, asks for no key and stores nothing", async () => {
    const secretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-openrouter-AbCdEf";
    const scripted = scriptedPrompter([
      ...settingsScript({ owner: "acme", flags: { openrouterSecretArn: secretArn }, advanced: { modelProvider: "openrouter", alertEmail: "ops@example.com" } }), "a/b", "a/b", "a/b", "",
    ]);
    const { prompter, hidden } = recordingSecrets(scripted);
    const collected = await collectInitAnswers({ ...base, flags: { openrouterSecretArn: secretArn }, prompter });
    expect(scripted.remaining()).toBe(0);
    expect(hidden).toEqual([]);
    expect(collected.openRouterKey).toBeUndefined();
    const secrets = memoryInitSecrets();
    const saved = await persistInitAnswers({ store: new MemoryParameterStore(), secrets, collected });
    expect(saved.models.openRouter).toEqual({ secretArn });
    expect(secrets.values.size).toBe(0);
  });

  it("lets per-component provider flags win over the provider question, so mixed setups still come from flags", async () => {
    const flags: InitFlags = { ...everyFlag, modelProvider: "openrouter", classifierProvider: "amazon-bedrock", orchestratorModel: "a/b", workerModel: "a/b", openrouterKey: { envName: "OR_KEY" } };
    const { answers } = await collectWithFlags({ ...base, processEnv: { OR_KEY: OPENROUTER_KEY }, flags });
    expect(answers.models.providers).toEqual({ orchestrator: "openrouter", classifier: "amazon-bedrock", worker: "openrouter" });
    expect(answers.models.classifier).toBe("us.anthropic.claude-haiku-4-5-20251001-v1:0");
  });

  it("writes no answers when the key cannot be stored, and never names the key in the error", async () => {
    const collected = await collectInitAnswers({ ...base, flags: {}, prompter: scriptedPrompter(OPENROUTER_RUN) });
    const store = new MemoryParameterStore();
    const secrets = { ...memoryInitSecrets(), create: async () => { throw Object.assign(new Error("User is not authorized to perform: secretsmanager:CreateSecret"), { name: "AccessDeniedException" }); } };
    const failure = await persistInitAnswers({ store, secrets, collected }).then(() => undefined, (error: unknown) => error as Error);
    expect(failure?.message).toContain("not authorized");
    expect(failure?.message).not.toContain(OPENROUTER_KEY);
    expect(await readInstallAnswers(store, "staging")).toBeUndefined();
  });

  it("refuses a resume flag that changes the provider question's answer", async () => {
    const collected = await collectInitAnswers({ ...base, flags: {}, prompter: scriptedPrompter(OPENROUTER_RUN) });
    expect(() => assertResumeFlagsMatch(collected.answers, { modelProvider: "openrouter" })).not.toThrow();
    expect(() => assertResumeFlagsMatch(collected.answers, { modelProvider: "amazon-bedrock" })).toThrow("--model-provider amazon-bedrock differs");
  });
});

describe("resuming with flags", () => {
  it("refuses a flag that differs from what the install started with, and accepts matching ones", async () => {
    const { answers } = await collectWithFlags({ ...base, flags: everyFlag });
    expect(() => assertResumeFlagsMatch(answers, { orchestratorModel: "us.anthropic.claude-sonnet-4-6" })).not.toThrow();
    expect(() => assertResumeFlagsMatch(answers, { orchestratorModel: "zai.glm-4.7" })).toThrow(
      "--orchestrator-model zai.glm-4.7 differs from what this install started with (us.anthropic.claude-sonnet-4-6); an install's answers cannot change halfway. Run agentx init without that flag to continue",
    );
    expect(() => assertResumeFlagsMatch(answers, { engine: "cdk" })).toThrow("--engine cdk differs");
  });

  it("also checks the OIDC flags (F10), refusing a stored cognito install's oidc fields as not set", async () => {
    const flags: InitFlags = { ...everyFlag, identity: "oidc", oidcIssuer: "https://id.example.com", oidcAudience: "agentx", oidcClientId: "cli", adminClaim: "groups", adminValues: "agentx-admins, platform" };
    const { answers } = await collectWithFlags({ ...base, flags });
    expect(() => assertResumeFlagsMatch(answers, { oidcIssuer: "https://id.example.com", oidcAudience: "agentx", oidcClientId: "cli", adminClaim: "groups", adminValues: "agentx-admins, platform" })).not.toThrow();
    expect(() => assertResumeFlagsMatch(answers, { oidcIssuer: "https://other.example.com" })).toThrow(
      "--oidc-issuer https://other.example.com differs from what this install started with (https://id.example.com); an install's answers cannot change halfway. Run agentx init without that flag to continue",
    );
    expect(() => assertResumeFlagsMatch(answers, { adminClaim: "role" })).toThrow("--admin-claim role differs");
    expect(() => assertResumeFlagsMatch(answers, { adminValues: "other-group, platform" })).toThrow("--admin-values other-group, platform differs");

    const { answers: cognitoAnswers } = await collectWithFlags({ ...base, flags: everyFlag });
    expect(() => assertResumeFlagsMatch(cognitoAnswers, { oidcIssuer: "https://id.example.com" })).toThrow(
      "--oidc-issuer https://id.example.com differs from what this install started with (not set); an install's answers cannot change halfway. Run agentx init without that flag to continue",
    );
  });

  it("normalizes before comparing on resume (Fix round 1, item 2): trailing slash, case and admin values as a set", async () => {
    const flags: InitFlags = { ...everyFlag, identity: "oidc", oidcIssuer: "https://id.example.com", oidcAudience: "agentx", oidcClientId: "cli", adminClaim: "groups", adminValues: "agentx-admins, platform" };
    const { answers } = await collectWithFlags({ ...base, flags });

    // A trailing slash on the OIDC issuer must not refuse a matching resume, but a genuinely
    // different issuer must still be refused.
    expect(() => assertResumeFlagsMatch(answers, { oidcIssuer: "https://id.example.com/" })).not.toThrow();
    expect(() => assertResumeFlagsMatch(answers, { oidcIssuer: "https://other.example.com" })).toThrow(
      "--oidc-issuer https://other.example.com differs from what this install started with (https://id.example.com); an install's answers cannot change halfway. Run agentx init without that flag to continue",
    );

    // Admin values compare as a set: reordered or reformatted (no space after the comma) is the
    // same set and must not refuse; a genuinely different set of values must still be refused.
    expect(() => assertResumeFlagsMatch(answers, { adminValues: "platform, agentx-admins" })).not.toThrow();
    expect(() => assertResumeFlagsMatch(answers, { adminValues: "agentx-admins,platform" })).not.toThrow();
    expect(() => assertResumeFlagsMatch(answers, { adminValues: "agentx-admins" })).toThrow("--admin-values agentx-admins differs");

    const { answers: emailAnswers } = await collectWithFlags({ ...base, flags: everyFlag });

    // GitHub logins and email addresses compare case-insensitively, but a genuinely different
    // value must still be refused.
    expect(() => assertResumeFlagsMatch(emailAnswers, { githubAccount: "ACME" })).not.toThrow();
    expect(() => assertResumeFlagsMatch(emailAnswers, { githubAccount: "other" })).toThrow("--github-account other differs");
    expect(() => assertResumeFlagsMatch(emailAnswers, { alertEmail: "OPS@EXAMPLE.COM" })).not.toThrow();
    expect(() => assertResumeFlagsMatch(emailAnswers, { alertEmail: "other@example.com" })).toThrow("--alert-email other@example.com differs");

    // Surrounding whitespace never causes a spurious refusal.
    expect(() => assertResumeFlagsMatch(emailAnswers, { orchestratorModel: " us.anthropic.claude-sonnet-4-6 " })).not.toThrow();
  });

  it("also checks --alert-webhook-* and --no-alerts (F10) against the stored alert kind", async () => {
    const { answers: emailAnswers } = await collectWithFlags({ ...base, flags: everyFlag });
    expect(() => assertResumeFlagsMatch(emailAnswers, { alerts: false })).toThrow(
      "--no-alerts differs from what this install started with (email); an install's answers cannot change halfway. Run agentx init without that flag to continue",
    );
    expect(() => assertResumeFlagsMatch(emailAnswers, { alertWebhook: { envName: "AGENTX_ALERT_WEBHOOK" } })).toThrow(
      "--alert-webhook-env AGENTX_ALERT_WEBHOOK differs from what this install started with (email); an install's answers cannot change halfway. Run agentx init without that flag to continue",
    );
    expect(() => assertResumeFlagsMatch(emailAnswers, { alertWebhook: { file: "/tmp/webhook.txt" } })).toThrow("--alert-webhook-file /tmp/webhook.txt differs");

    const noneFlags: InitFlags = { ...everyFlag, alertEmail: undefined, alerts: false } as InitFlags;
    const { answers: noneAnswers } = await collectWithFlags({ ...base, flags: noneFlags });
    expect(() => assertResumeFlagsMatch(noneAnswers, { alerts: false })).not.toThrow();
    expect(() => assertResumeFlagsMatch(noneAnswers, { alertEmail: "ops@example.com" })).toThrow(
      "--alert-email ops@example.com differs from what this install started with (not set); an install's answers cannot change halfway. Run agentx init without that flag to continue",
    );

    const webhookFlags: InitFlags = { ...everyFlag, alertEmail: undefined, alertWebhook: { envName: "AGENTX_ALERT_WEBHOOK" } } as InitFlags;
    const { answers: webhookAnswers } = await collectWithFlags({ ...base, processEnv: { AGENTX_ALERT_WEBHOOK: WEBHOOK }, flags: webhookFlags });
    expect(() => assertResumeFlagsMatch(webhookAnswers, { alertWebhook: { envName: "AGENTX_ALERT_WEBHOOK" } })).not.toThrow();
    expect(() => assertResumeFlagsMatch(webhookAnswers, { alerts: false })).toThrow("--no-alerts differs from what this install started with (webhook)");
  });
});

describe("the questions an export bundle already answered (FR-026)", () => {
  const secretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:team/openrouter-AbCdEf";
  const fixed = {
    schemaVersion: 1 as const, env: "staging", region: "us-east-1", account: "123456789012", engine: "templates" as const, releaseVersion: "1.2.3",
    identity: { mode: "oidc" as const, issuer: "https://idp.example.com", audience: "api://agentx", adminClaim: "groups", adminValues: ["admins"] },
    models: { orchestrator: "zai.glm-4.7", classifier: "c", worker: "w", providers: { worker: "openrouter" as const }, openRouter: { secretArn } },
    permissionsBoundaryArn: "arn:aws:iam::123456789012:policy/team-boundary",
  };

  it("asks only the alert, budget, GitHub and Slack questions, and takes the rest from the bundle", async () => {
    const prompter = scriptedPrompter([...settingsScript({ owner: "acme", fixed: true, advanced: { alertEmail: "ops@example.com" } }), ""]);
    const collected = await collectInitAnswers({ ...base, flags: {}, prompter, fixed });
    expect(prompter.remaining()).toBe(0);
    for (const question of ["Deploy engine", "Sign-in", "Model provider", "Orchestrator model", "Worker model id", "Worker model", "Install name"]) expect(prompter.asked).not.toContain(question);
    expect(prompter.asked.some((question) => /Permission boundary|operator role|OpenRouter/.test(question))).toBe(false);
    expect(collected.answers).toMatchObject({ engine: "templates", identity: fixed.identity, models: fixed.models, permissionsBoundaryArn: fixed.permissionsBoundaryArn });
    expect(collected.answers.operatorPrincipalArn).toBeUndefined();
    // The bundle's OpenRouter secret is the team's own: no key is read or stored.
    expect(collected.openRouterKey).toBeUndefined();
    expect(collected.notes).toContain(GLM_NOTE);
  });
});

describe("spec 048 FR-026: app names", () => {
  it("names both apps AgentX <owner> (<install name>)", () => {
    expect(defaultAppName({ owner: "acme", env: "staging" })).toBe("AgentX acme (staging)");
  });

  it("the longest owner and install name still fit, and both apps match", async () => {
    const owner = "a".repeat(39);
    const env = "abcdefghij-klmnopqrs";
    expect(env.length).toBe(20);
    const name = defaultAppName({ owner, env });
    expect(name).toBe("AgentX (abcdefghij-klmnopqrs)");
    expect(name.length).toBeLessThanOrEqual(GITHUB_APP_NAME_LIMIT);

    const prompter = scriptedPrompter([...settingsScript({ env, owner, advanced: { alertEmail: "ops@example.com" } }), ""]);
    const collected = await collectInitAnswers({ env, region: "us-east-1", account: "123456789012", releaseVersion: "1.2.3", flags: {}, prompter, processEnv: {}, now: () => 0 });
    expect(collected.answers.github.appName).toBe(name);
    expect(collected.answers.slack.appName).toBe(name);
  });

  it("the Slack name follows a GitHub name the user typed", async () => {
    // Spec 048 FR-020: one name for both apps.
    const prompter = scriptedPrompter([...settingsScript({ owner: "acme", appName: "Our AgentX", advanced: { alertEmail: "ops@example.com" } }), ""]);
    const collected = await collectInitAnswers({ env: "staging", region: "us-east-1", account: "123456789012", releaseVersion: "1.2.3", flags: {}, prompter, processEnv: {}, now: () => 0 });
    expect(collected.answers.slack.appName).toBe("Our AgentX");
  });
});
