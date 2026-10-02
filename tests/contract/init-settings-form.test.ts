// Spec 048 FR-020 to FR-023 and FR-025: the settings as one form.
import { describe, expect, it } from "vitest";
import { collectInitAnswers, DEFAULT_CLASSIFIER_MODEL, DEFAULT_ORCHESTRATOR_MODEL, DEFAULT_WORKER_MODEL, defaultAppName } from "../../packages/cli/src/init/answers.js";
import { estimateMonthlyCost, PRICE_NOT_ON_FILE, suggestedBudgetUsd } from "../../packages/cli/src/init/cost.js";
import { githubRestApi } from "../../packages/cli/src/init/github-app.js";
import { unattendedPrompter } from "../../packages/cli/src/init/prompts.js";
import { installNameProblem, recommendedSummary, SETTINGS_FIELD, settingsFields, SIGN_IN_GROUP, WORKER_MODEL_CHOICES } from "../../packages/cli/src/init/settings-form.js";
import { scriptedPrompter, settingsScript } from "../support/init-fakes.js";

const defaults = { orchestrator: DEFAULT_ORCHESTRATOR_MODEL, classifier: DEFAULT_CLASSIFIER_MODEL, worker: DEFAULT_WORKER_MODEL };
const base = { region: "us-east-1", account: "123456789012", releaseVersion: "1.2.3", processEnv: {}, now: () => 0 };

describe("the settings form", () => {
  it("FR-020: asks four things on the default path, and puts every other setting under Advanced", () => {
    const fields = settingsFields({ env: "production", flags: {}, fixed: false, budgetWhy: "" });
    expect(fields.filter((field) => field.section !== "advanced").map((field) => field.name)).toEqual(["email", "githubAccount", "installName", "appName"]);
    expect(fields.filter((field) => field.section === "advanced").map((field) => field.name)).toEqual([
      "engine", "identity", "signin", "modelProvider", "orchestratorModel", "classifierModel", "workerModel",
      "permissionBoundary", "operatorPrincipal", "budget", "budgetScope", "appPostedMessages", "alertKind", "alertEmail",
    ]);
    expect(fields.find((field) => field.name === "installName")?.defaultValue).toBe("production");
    expect(fields.map((field) => field.name)).toEqual(Object.values(SETTINGS_FIELD));
  });

  it("FR-021: no Advanced setting is required: each has a choice default or accepts an empty answer", () => {
    for (const field of settingsFields({ env: "production", flags: {}, fixed: false, budgetWhy: "" }).filter((each) => each.section === "advanced")) {
      const optional = field.choices !== undefined ? field.defaultValue !== undefined : field.defaultValue === "" && field.validate?.("") === undefined;
      expect({ field: field.name, optional }).toEqual({ field: field.name, optional: true });
    }
  });

  it("FR-022: asks how the admin and developers sign in under one heading", () => {
    const grouped = settingsFields({ env: "production", flags: {}, fixed: false, budgetWhy: "" }).filter((field) => field.group === SIGN_IN_GROUP);
    expect(grouped.map((field) => field.name)).toEqual(["identity", "signin"]);
  });

  it("FR-020: your own OIDC with the alerts answered by a flag needs no email; without such a flag it does", () => {
    const names = (flags: Parameters<typeof settingsFields>[0]["flags"]) => settingsFields({ env: "staging", flags, fixed: false, budgetWhy: "" }).map((field) => field.name);
    expect(names({ identity: "oidc", alerts: false })).not.toContain("email");
    expect(names({ identity: "oidc", alertWebhook: { envName: "HOOK" } })).not.toContain("email");
    expect(names({ identity: "oidc" })).toContain("email");
    expect(names({ alerts: false })).toContain("email");
  });

  it("explains the settings email in the context of the form", () => {
    const email = settingsFields({ env: "staging", flags: {}, fixed: false, budgetWhy: "" }).find((field) => field.name === "email");
    expect(email?.help?.why).toBe("AgentX uses it for your admin sign-in and, by default, for alerts.");
  });

  it("FR-023: the budget field says the suggested amount, on the page and in the terminal", () => {
    const budget = settingsFields({ env: "staging", flags: {}, fixed: false, budgetWhy: "" }).find((field) => field.name === "budget");
    expect(budget?.question).toBe("Monthly AWS budget for this environment, in US dollars (0 for none; empty for the estimate plus 20%, $260)");
    expect(budget?.help?.hint).toBe("Optional. Leave empty to use the estimate plus 20% ($260).");
  });

  it("leaves out every field a typed flag already answers, and the platform fields for a bundle", () => {
    const names = (flags: Parameters<typeof settingsFields>[0]["flags"], fixed = false) => settingsFields({ env: "staging", flags, fixed, budgetWhy: "" }).map((field) => field.name);
    expect(names({ githubAccount: "acme", engine: "cdk", budget: "300" })).not.toEqual(expect.arrayContaining(["githubAccount", "engine", "budget"]));
    expect(names({ alerts: false })).not.toContain("alertKind");
    expect(names({ modelProvider: "openrouter" })).not.toContain("orchestratorModel");
    expect(names({}, true)).not.toEqual(expect.arrayContaining(["engine", "identity", "installName", "orchestratorModel", "permissionBoundary"]));
  });

  it("FR-020: says the recommended settings in plain words", () => {
    expect(recommendedSummary({ estimateUsd: 211.4, suggestedBudgetUsd: 260 })).toEqual([
      "Models: Claude Sonnet 4.6 on Amazon Bedrock for the main and coding models, Amazon Nova Lite for the safety check.",
      "Sign-in: AgentX's own sign-in for you, Sign in with Slack for developers.",
      "Budget alert: $260 a month for the whole account (the estimate is about $211.40).",
      "Alerts go to: your email.",
    ]);
  });

  it("FR-021 and FR-082: offers the coding model as a choice, every choice priced", () => {
    expect(WORKER_MODEL_CHOICES.map((choice) => choice.value)).toEqual([DEFAULT_WORKER_MODEL, "amazon.nova-pro-v1:0"]);
    for (const choice of WORKER_MODEL_CHOICES) expect(choice.label).not.toContain(PRICE_NOT_ON_FILE);
  });
});

describe("answers from the settings", () => {
  it("FR-020, FR-023 and FR-025: the default path gives the recommended install, alerts to your email", async () => {
    const prompter = scriptedPrompter(settingsScript({ email: "alice@example.com", owner: "acme" }));
    const { answers, settings } = await collectInitAnswers({ ...base, env: "staging", flags: {}, prompter, ownerType: async () => "organization" });
    expect(answers).toMatchObject({
      env: "staging", engine: "templates", identity: { mode: "cognito" }, models: defaults,
      alert: { kind: "email", address: "alice@example.com" }, adminEmail: "alice@example.com", signinMethods: "slack",
      budget: { monthlyUsd: suggestedBudgetUsd(estimateMonthlyCost(defaults)), scope: "account" },
      github: { account: "acme", accountType: "organization", appName: defaultAppName({ owner: "acme", env: "staging" }) },
      slack: { appName: defaultAppName({ owner: "acme", env: "staging" }), appPostedMessages: "accept" },
    });
    expect(prompter.asked).toEqual([
      "Your email, for your AgentX admin user and alerts", "GitHub organization or user that will own the AgentX GitHub App", "Install name",
      "App name for GitHub and Slack (unique on GitHub)", "Change the advanced settings?",
    ]);
    expect(settings).toMatchObject({ email: "alice@example.com", githubAccount: "acme" });
  });

  it("FR-020: asks the owner's type only when GitHub cannot say", async () => {
    const asked = scriptedPrompter([...settingsScript({ owner: "acme" }), "user"]);
    const { answers } = await collectInitAnswers({ ...base, env: "staging", flags: {}, prompter: asked, ownerType: async () => undefined });
    expect(asked.asked.at(-1)).toBe("Is acme an organization or a personal account?");
    expect(answers.github.accountType).toBe("user");
  });

  it("FR-023: a budget left empty is the estimate of the models chosen, plus 20%", async () => {
    const glm = "zai.glm-4.7";
    const prompter = scriptedPrompter(settingsScript({ owner: "acme", advanced: { orchestratorModel: glm } }));
    const { answers } = await collectInitAnswers({ ...base, env: "staging", flags: {}, prompter, ownerType: async () => "organization" });
    expect(answers.budget?.monthlyUsd).toBe(suggestedBudgetUsd(estimateMonthlyCost({ ...defaults, orchestrator: glm })));
  });

  it("FR-025: alerts turned off in Advanced say what is given up", async () => {
    const prompter = scriptedPrompter(settingsScript({ owner: "acme", advanced: { alertKind: "none" } }));
    const { answers, notes } = await collectInitAnswers({ ...base, env: "staging", flags: {}, prompter, ownerType: async () => "organization" });
    expect(answers.alert).toEqual({ kind: "none" });
    expect(notes.some((note) => /nobody is told when AgentX fails/.test(note))).toBe(true);
  });

  it("a typed app name names both apps; another install name moves the default", async () => {
    const typed = await collectInitAnswers({ ...base, env: "staging", flags: {}, prompter: scriptedPrompter(settingsScript({ owner: "acme", appName: "Our AgentX" })), ownerType: async () => "organization" });
    expect([typed.answers.github.appName, typed.answers.slack.appName]).toEqual(["Our AgentX", "Our AgentX"]);
    const moved = await collectInitAnswers({ ...base, env: "staging", flags: {}, prompter: scriptedPrompter(settingsScript({ owner: "acme", installName: "prod" })), ownerType: async () => "organization" });
    expect(moved.answers.env).toBe("prod");
    expect(moved.answers.github.appName).toBe("AgentX acme (prod)");
  });
});

describe("the settings form's own checks", () => {
  it("the install name follows --env's rules, in plain words", () => {
    expect(installNameProblem("trial-2")).toBeUndefined();
    for (const bad of ["Trial", "2trial", "trial-", "tri--al", "a".repeat(21)]) {
      expect(installNameProblem(bad)).toBe("use lowercase letters, numbers and single hyphens, starting with a letter and ending with a letter or number, at most 20 characters");
    }
    for (const reserved of ["connectors", "qqenv-placeholderqq", "my-qqenv"]) expect(installNameProblem(reserved)).toBe("that name is reserved; choose another");
  });

  it("FR-025: --admin-email with no alert flag sends alerts to that address, under --yes too", async () => {
    const flags = { githubAccount: "acme", githubAccountType: "organization" as const };
    const { answers } = await collectInitAnswers({ ...base, env: "staging", flags, prompter: unattendedPrompter(), adminEmail: "alice@example.com" });
    expect(answers.alert).toEqual({ kind: "email", address: "alice@example.com" });
    expect(answers.adminEmail).toBe("alice@example.com");
  });

  it("--signin answers the developer sign-in setting, and the Slack app name flag still names the Slack app", async () => {
    const prompter = scriptedPrompter(settingsScript({ owner: "acme", flags: { slackAppName: "Our Slack AgentX" } }));
    const { answers } = await collectInitAnswers({ ...base, env: "staging", flags: { slackAppName: "Our Slack AgentX" }, prompter, signinMethods: "both", ownerType: async () => "organization" });
    expect(answers.signinMethods).toBe("both");
    expect(answers.slack.appName).toBe("Our Slack AgentX");
    expect(answers.github.appName).toBe("AgentX acme (staging)");
    expect(prompter.asked).not.toContain("How will developers sign in to AgentX from their AI tools?");
  });

  it("Change answers starts the form from the kept settings", async () => {
    // Enter on each of the four takes the kept value; no to the Advanced settings.
    const prompter = scriptedPrompter(["", "", "", "", false]);
    const kept = { email: "kept@example.com", githubAccount: "kept-org", installName: "kept" };
    const { answers, settings } = await collectInitAnswers({ ...base, env: "staging", flags: {}, prompter, kept, ownerType: async () => "user" });
    expect(answers).toMatchObject({ env: "kept", adminEmail: "kept@example.com", github: { account: "kept-org", accountType: "user" } });
    expect(settings).toMatchObject(kept);
  });
});

describe("GitHub owner lookup (FR-020)", () => {
  const reply = (status: number, body: unknown = {}) => async () => new Response(JSON.stringify(body), { status });

  it("names an organization or a user, and undefined for no such owner", async () => {
    expect(await githubRestApi(reply(200, { login: "Acme", type: "Organization" }) as typeof fetch).owner?.("acme")).toEqual({ login: "Acme", type: "Organization" });
    expect(await githubRestApi(reply(200, { login: "alice", type: "User" }) as typeof fetch).owner?.("alice")).toEqual({ login: "alice", type: "User" });
    expect(await githubRestApi(reply(404) as typeof fetch).owner?.("nobody")).toBeUndefined();
  });

  it("throws when GitHub cannot answer, naming the status only", async () => {
    await expect(githubRestApi(reply(403) as typeof fetch).owner?.("acme")).rejects.toThrow("GitHub owner lookup failed with HTTP 403");
  });
});
