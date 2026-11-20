// Spec 048 FR-020 to FR-023 and FR-025: the settings as one form.
import { describe, expect, it } from "vitest";
import { collectInitAnswers } from "../../packages/cli/src/init/answers.js";
import { githubRestApi } from "../../packages/cli/src/init/github-app.js";
import { installNameProblem, settingsFields, SIGN_IN_GROUP } from "../../packages/cli/src/init/settings-form.js";
import { scriptedPrompter, settingsScript } from "../support/init-fakes.js";

const base = { region: "us-east-1", account: "123456789012", releaseVersion: "1.2.3", processEnv: {}, now: () => 0 };

describe("the settings form", () => {

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

});

describe("answers from the settings", () => {

  it("FR-025: alerts turned off in Advanced say what is given up", async () => {
    const prompter = scriptedPrompter(settingsScript({ owner: "acme", advanced: { alertKind: "none" } }));
    const { answers, notes } = await collectInitAnswers({ ...base, env: "staging", flags: {}, prompter, ownerType: async () => "organization" });
    expect(answers.alert).toEqual({ kind: "none" });
    expect(notes.some((note) => /nobody is told when AgentX fails/.test(note))).toBe(true);
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

  it("--signin answers the developer sign-in setting, and the Slack app name flag still names the Slack app", async () => {
    const prompter = scriptedPrompter(settingsScript({ owner: "acme", flags: { slackAppName: "Our Slack AgentX" } }));
    const { answers } = await collectInitAnswers({ ...base, env: "staging", flags: { slackAppName: "Our Slack AgentX" }, prompter, signinMethods: "both", ownerType: async () => "organization" });
    expect(answers.signinMethods).toBe("both");
    expect(answers.slack.appName).toBe("Our Slack AgentX");
    expect(answers.github.appName).toBe("Rovara acme (staging)");
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
