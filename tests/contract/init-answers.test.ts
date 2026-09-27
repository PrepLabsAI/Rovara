import { describe, expect, it } from "vitest";
import {
  alertWebhookSecretName, assertResumeFlagsMatch, collectInitAnswers, GLM_NOTE, HAIKU_NOTE, persistInitAnswers, type InitFlags,
} from "../../packages/cli/src/init/answers.js";
import { readInstallAnswers } from "../../packages/cli/src/init/install-state.js";
import { unattendedPrompter } from "../../packages/cli/src/init/prompts.js";
import { GITHUB_LOGIN_PATTERN } from "../../packages/cli/src/deploy/answer-schemas.js";
import { SecretAlreadyExistsError } from "../../packages/cli/src/deploy/signing-key.js";
import { scriptedPrompter } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const T0 = Date.parse("2026-09-27T00:00:00.000Z");
const WEBHOOK = "https://api.opsgenie.com/v1/json/amazonsns?apiKey=0f9e8d7c-SECRET-KEY-6b5a";
const base = { env: "staging", region: "us-east-1", account: "123456789012", releaseVersion: "1.2.3", processEnv: {}, now: () => T0 };

const everyFlag: InitFlags = {
  engine: "templates", identity: "cognito",
  orchestratorModel: "us.anthropic.claude-sonnet-4-6", classifierModel: "amazon.nova-lite-v1:0", workerModel: "amazon.nova-pro-v1:0",
  permissionBoundary: "", operatorPrincipal: "",
  alertEmail: "ops@example.com",
  githubAccount: "acme", githubAccountType: "organization", githubAppName: "AgentX acme staging",
  slackAppName: "AgentX", slackAppPostedMessages: "accept",
};

function memoryAlertSecrets() {
  const values = new Map<string, string>();
  return {
    values,
    async create(name: string, value: string) { if (values.has(name)) throw new SecretAlreadyExistsError(name); values.set(name, value); },
    async put(name: string, value: string) { values.set(name, value); },
  };
}

describe("init questions", () => {
  it("takes every default with Enter and asks for what has no default", async () => {
    const prompter = scriptedPrompter(["", "", "", "", "", "", "", "", "ops@example.com", "acme", "", "", "", ""]);
    const { answers, notes, alertWebhook } = await collectInitAnswers({ ...base, flags: {}, prompter });
    expect(prompter.remaining()).toBe(0);
    expect(alertWebhook).toBeUndefined();
    expect(notes).toEqual([]);
    expect(answers).toEqual({
      schemaVersion: 1, env: "staging", region: "us-east-1", account: "123456789012", engine: "templates", releaseVersion: "1.2.3",
      identity: { mode: "cognito" },
      models: { orchestrator: "us.anthropic.claude-sonnet-4-6", classifier: "amazon.nova-lite-v1:0", worker: "amazon.nova-pro-v1:0" },
      alert: { kind: "email", address: "ops@example.com" },
      github: { account: "acme", accountType: "organization", appName: "AgentX acme staging" },
      slack: { appName: "AgentX", appPostedMessages: "accept" },
      createdAt: "2026-09-27T00:00:00.000Z",
    });
  });

  it("asks nothing when every flag is given", async () => {
    const { answers } = await collectInitAnswers({ ...base, flags: everyFlag, prompter: scriptedPrompter([]) });
    expect(answers.github.appName).toBe("AgentX acme staging");
  });

  it("states GLM 4.7's trade-off and Claude Haiku 4.5's model-access need when chosen", async () => {
    const { answers, notes } = await collectInitAnswers({ ...base, flags: { ...everyFlag, orchestratorModel: "zai.glm-4.7", classifierModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0" }, prompter: scriptedPrompter([]) });
    expect(answers.models.orchestrator).toBe("zai.glm-4.7");
    expect(notes).toEqual([GLM_NOTE, HAIKU_NOTE]);
    expect(GLM_NOTE).toContain("6 of 7");
  });

  it("accepts another Bedrock model id for the orchestrator", async () => {
    const prompter = scriptedPrompter(["other", "us.amazon.nova-premier-v1:0"]);
    const { answers } = await collectInitAnswers({ ...base, flags: { ...everyFlag, orchestratorModel: undefined } as InitFlags, prompter });
    expect(answers.models.orchestrator).toBe("us.amazon.nova-premier-v1:0");
  });

  it("collects your own OIDC provider's issuer, audience, client and admin claim", async () => {
    const flags: InitFlags = { ...everyFlag, identity: "oidc", oidcIssuer: "https://id.example.com", oidcAudience: "agentx", oidcClientId: "cli", adminClaim: "groups", adminValues: "agentx-admins, platform" };
    const { answers } = await collectInitAnswers({ ...base, flags, prompter: scriptedPrompter([]) });
    expect(answers.identity).toEqual({ mode: "oidc", issuer: "https://id.example.com", audience: "agentx", clientId: "cli", adminClaim: "groups", adminValues: ["agentx-admins", "platform"] });
  });

  it("keeps a webhook address out of the answers and stores it only as a secret (Review Focus 4)", async () => {
    const flags: InitFlags = { ...everyFlag, alertEmail: undefined } as InitFlags;
    const prompter = scriptedPrompter(["webhook", `  ${WEBHOOK}\r\n`]);
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
    const collected = await collectInitAnswers({ ...base, processEnv: { AGENTX_ALERT_WEBHOOK: WEBHOOK }, flags, prompter: scriptedPrompter([]) });
    const secrets = memoryAlertSecrets();
    secrets.values.set("agentx/staging/alert-endpoint", "https://stale.example.com/x");
    await persistInitAnswers({ store: new MemoryParameterStore(), secrets, collected });
    expect(secrets.values.get("agentx/staging/alert-endpoint")).toBe(WEBHOOK);

    let message = "";
    try {
      await collectInitAnswers({ ...base, processEnv: { AGENTX_ALERT_WEBHOOK: "http://hooks.example.com/k=SECRET-KEY" }, flags, prompter: scriptedPrompter([]) });
    } catch (error) { message = (error as Error).message; }
    expect(message).toContain("an alert webhook must be an https:// address");
    expect(message).not.toContain("SECRET-KEY");
  });

  it("with --yes and no alert flag, names every way to answer", async () => {
    const flags = { ...everyFlag, alertEmail: undefined } as InitFlags;
    await expect(collectInitAnswers({ ...base, flags, prompter: unattendedPrompter() }))
      .rejects.toThrow("Alert email address needs an answer; with --yes, pass --alert-email (or --alert-webhook-file, --alert-webhook-env, --no-alerts)");
  });

  it("records no alerts for --no-alerts, with a note saying nobody will hear about failures", async () => {
    const { answers, notes } = await collectInitAnswers({ ...base, flags: { ...everyFlag, alertEmail: undefined, alerts: false } as InitFlags, prompter: scriptedPrompter([]) });
    expect(answers.alert).toEqual({ kind: "none" });
    expect(notes.join("\n")).toContain("nobody is told when AgentX fails");
  });

  it("refuses an image override that is not a digest reference", async () => {
    await expect(collectInitAnswers({ ...base, flags: { ...everyFlag, workerImage: "repo/worker:latest" }, prompter: scriptedPrompter([]) }))
      .rejects.toThrow("--worker-image must be referenced by digest (repository@sha256:...)");
  });

  it("with --yes and no GitHub account, names the flag", async () => {
    await expect(collectInitAnswers({ ...base, flags: { ...everyFlag, githubAccount: undefined } as InitFlags, prompter: unattendedPrompter() }))
      .rejects.toThrow("with --yes, pass --github-account");
  });

  it("shares the GitHub login pattern with install-state's schema (Fix round 1, item 1), refusing the same invalid login", async () => {
    expect(GITHUB_LOGIN_PATTERN.test("-bad")).toBe(false);
    await expect(collectInitAnswers({ ...base, flags: { ...everyFlag, githubAccount: "-bad" }, prompter: scriptedPrompter([]) }))
      .rejects.toThrow("--github-account -bad is not a GitHub organization or user name");
  });
});

describe("resuming with flags", () => {
  it("refuses a flag that differs from what the install started with, and accepts matching ones", async () => {
    const { answers } = await collectInitAnswers({ ...base, flags: everyFlag, prompter: scriptedPrompter([]) });
    expect(() => assertResumeFlagsMatch(answers, { orchestratorModel: "us.anthropic.claude-sonnet-4-6" })).not.toThrow();
    expect(() => assertResumeFlagsMatch(answers, { orchestratorModel: "zai.glm-4.7" })).toThrow(
      "--orchestrator-model zai.glm-4.7 differs from what this install started with (us.anthropic.claude-sonnet-4-6); an install's answers cannot change halfway. Run agentx init without that flag to continue",
    );
    expect(() => assertResumeFlagsMatch(answers, { engine: "cdk" })).toThrow("--engine cdk differs");
  });

  it("also checks the OIDC flags (F10), refusing a stored cognito install's oidc fields as not set", async () => {
    const flags: InitFlags = { ...everyFlag, identity: "oidc", oidcIssuer: "https://id.example.com", oidcAudience: "agentx", oidcClientId: "cli", adminClaim: "groups", adminValues: "agentx-admins, platform" };
    const { answers } = await collectInitAnswers({ ...base, flags, prompter: scriptedPrompter([]) });
    expect(() => assertResumeFlagsMatch(answers, { oidcIssuer: "https://id.example.com", oidcAudience: "agentx", oidcClientId: "cli", adminClaim: "groups", adminValues: "agentx-admins, platform" })).not.toThrow();
    expect(() => assertResumeFlagsMatch(answers, { oidcIssuer: "https://other.example.com" })).toThrow(
      "--oidc-issuer https://other.example.com differs from what this install started with (https://id.example.com); an install's answers cannot change halfway. Run agentx init without that flag to continue",
    );
    expect(() => assertResumeFlagsMatch(answers, { adminClaim: "role" })).toThrow("--admin-claim role differs");
    expect(() => assertResumeFlagsMatch(answers, { adminValues: "other-group, platform" })).toThrow("--admin-values other-group, platform differs");

    const { answers: cognitoAnswers } = await collectInitAnswers({ ...base, flags: everyFlag, prompter: scriptedPrompter([]) });
    expect(() => assertResumeFlagsMatch(cognitoAnswers, { oidcIssuer: "https://id.example.com" })).toThrow(
      "--oidc-issuer https://id.example.com differs from what this install started with (not set); an install's answers cannot change halfway. Run agentx init without that flag to continue",
    );
  });

  it("normalizes before comparing on resume (Fix round 1, item 2): trailing slash, case and admin values as a set", async () => {
    const flags: InitFlags = { ...everyFlag, identity: "oidc", oidcIssuer: "https://id.example.com", oidcAudience: "agentx", oidcClientId: "cli", adminClaim: "groups", adminValues: "agentx-admins, platform" };
    const { answers } = await collectInitAnswers({ ...base, flags, prompter: scriptedPrompter([]) });

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

    const { answers: emailAnswers } = await collectInitAnswers({ ...base, flags: everyFlag, prompter: scriptedPrompter([]) });

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
    const { answers: emailAnswers } = await collectInitAnswers({ ...base, flags: everyFlag, prompter: scriptedPrompter([]) });
    expect(() => assertResumeFlagsMatch(emailAnswers, { alerts: false })).toThrow(
      "--no-alerts differs from what this install started with (email); an install's answers cannot change halfway. Run agentx init without that flag to continue",
    );
    expect(() => assertResumeFlagsMatch(emailAnswers, { alertWebhook: { envName: "AGENTX_ALERT_WEBHOOK" } })).toThrow(
      "--alert-webhook-env AGENTX_ALERT_WEBHOOK differs from what this install started with (email); an install's answers cannot change halfway. Run agentx init without that flag to continue",
    );
    expect(() => assertResumeFlagsMatch(emailAnswers, { alertWebhook: { file: "/tmp/webhook.txt" } })).toThrow("--alert-webhook-file /tmp/webhook.txt differs");

    const noneFlags: InitFlags = { ...everyFlag, alertEmail: undefined, alerts: false } as InitFlags;
    const { answers: noneAnswers } = await collectInitAnswers({ ...base, flags: noneFlags, prompter: scriptedPrompter([]) });
    expect(() => assertResumeFlagsMatch(noneAnswers, { alerts: false })).not.toThrow();
    expect(() => assertResumeFlagsMatch(noneAnswers, { alertEmail: "ops@example.com" })).toThrow(
      "--alert-email ops@example.com differs from what this install started with (not set); an install's answers cannot change halfway. Run agentx init without that flag to continue",
    );

    const webhookFlags: InitFlags = { ...everyFlag, alertEmail: undefined, alertWebhook: { envName: "AGENTX_ALERT_WEBHOOK" } } as InitFlags;
    const { answers: webhookAnswers } = await collectInitAnswers({ ...base, processEnv: { AGENTX_ALERT_WEBHOOK: WEBHOOK }, flags: webhookFlags, prompter: scriptedPrompter([]) });
    expect(() => assertResumeFlagsMatch(webhookAnswers, { alertWebhook: { envName: "AGENTX_ALERT_WEBHOOK" } })).not.toThrow();
    expect(() => assertResumeFlagsMatch(webhookAnswers, { alerts: false })).toThrow("--no-alerts differs from what this install started with (webhook)");
  });
});
