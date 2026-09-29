import { describe, expect, it } from "vitest";
import type { StackDescription } from "../../packages/cli/src/environments/adopt.js";
import { upgradeAnswers } from "../../packages/cli/src/upgrade/answers.js";
import { compareVersions, notesText, refusePrereleaseTarget, releaseNotes, upgradeDirection } from "../../packages/cli/src/upgrade/target.js";
import { SETTINGS } from "../support/doctor-fakes.js";

const KEY_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/github-app-AbCdEf";
const stacks = (parameters: Record<string, Record<string, string>>) => ({
  async describe(name: string): Promise<StackDescription | undefined> {
    return parameters[name] === undefined ? undefined : { status: "UPDATE_COMPLETE", outputs: {}, parameters: parameters[name] };
  },
});
const controlPlane = { GitHubAppId: "123", GitHubAppPrivateKeySecretArn: KEY_ARN, GitHubAppCredentialRef: "github-agentx-sdlc", CallbackSigningKey: "****", AdminClaim: "cognito:groups", AdminValues: "[\"agentx-admin\"]" };

describe("upgradeAnswers: everything from the environment itself, nothing asked", () => {
  it("builds a Cognito environment's answers from its settings and deployed stacks", async () => {
    const answers = await upgradeAnswers({ settings: SETTINGS, stacks: stacks({ "agentx-staging-control-plane": controlPlane, "agentx-staging-access": { OperatorPrincipalArn: "arn:aws:iam::123456789012:role/ops" } }) });
    expect(answers).toEqual({
      env: "staging", region: "us-east-1", account: "123456789012", models: SETTINGS.models, identity: { mode: "cognito" },
      github: { appId: "123", privateKeySecretArn: KEY_ARN, credentialRef: "github-agentx-sdlc" },
      operatorPrincipalArn: "arn:aws:iam::123456789012:role/ops",
    });
    // Never the callback signing key: deployEnvironment reads it from Secrets Manager itself.
    expect(JSON.stringify(answers)).not.toContain("****");
  });

  it("carries your own OIDC provider's admin claim and values from the control-plane stack", async () => {
    const oidc = { ...SETTINGS, identity: { mode: "oidc" as const, issuer: "https://idp.example.com", audience: "agentx", clientId: "cli" } };
    const answers = await upgradeAnswers({ settings: oidc, stacks: stacks({ "agentx-staging-control-plane": { ...controlPlane, AdminClaim: "groups", AdminValues: "[\"eng-admins\"]" } }) });
    expect(answers.identity).toEqual({ mode: "oidc", issuer: "https://idp.example.com", audience: "agentx", clientId: "cli", adminClaim: "groups", adminValues: ["eng-admins"] });
  });

  it("passes the testing-only image overrides, and the permission boundary from the settings", async () => {
    const settings = { ...SETTINGS, access: { artifactBucket: "b", cloudFormationRoleArn: "arn:aws:iam::123456789012:role/cfn", operatorRoleArn: "arn:aws:iam::123456789012:role/op", pullThroughPrefix: "agentx-staging", permissionsBoundaryArn: "arn:aws:iam::123456789012:policy/company-boundary" } };
    const answers = await upgradeAnswers({ settings, stacks: stacks({ "agentx-staging-control-plane": controlPlane }), images: { worker: `w@sha256:${"b".repeat(64)}` } });
    expect(answers.images).toEqual({ worker: `w@sha256:${"b".repeat(64)}` });
    expect(answers.permissionsBoundaryArn).toBe("arn:aws:iam::123456789012:policy/company-boundary");
  });

  it("refuses when the control-plane stack is gone or lacks the GitHub App", async () => {
    await expect(upgradeAnswers({ settings: SETTINGS, stacks: stacks({}) })).rejects.toThrow("stack agentx-staging-control-plane does not exist; agentx doctor says what else is missing");
    await expect(upgradeAnswers({ settings: SETTINGS, stacks: stacks({ "agentx-staging-control-plane": { GitHubAppId: "" } }) })).rejects.toThrow("stack agentx-staging-control-plane has no GitHubAppId parameter");
  });
});

describe("the target release", () => {
  it("orders versions, with a prerelease before its release", () => {
    expect(compareVersions("1.2.3", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareVersions("1.3.0-rc.1", "1.3.0")).toBeLessThan(0);
    expect(compareVersions("1.3.0", "1.3.0")).toBe(0);
  });

  it("allows the same release (a re-run) and a newer one, and refuses an older one (question 3)", () => {
    expect(upgradeDirection("staging", "1.2.3", "1.2.3")).toBe("same");
    expect(upgradeDirection("staging", "1.2.3", "1.3.0")).toBe("newer");
    expect(() => upgradeDirection("staging", "1.3.0", "1.2.3")).toThrow("release 1.2.3 is older than 1.3.0, which environment staging runs; agentx upgrade never moves an environment back");
  });

  it("reads the release's notes from GitHub, and says where to look when it cannot", async () => {
    const fetched: string[] = [];
    const notes = await releaseNotes({ version: "1.3.0", fetch: (async (url: string) => { fetched.push(url); return new Response(JSON.stringify({ body: "Fixes.\nMore fixes.", html_url: "https://github.com/PrepLabsAI/AgentX/releases/tag/v1.3.0" }), { status: 200 }); }) as never });
    expect(fetched).toEqual(["https://api.github.com/repos/PrepLabsAI/AgentX/releases/tags/v1.3.0"]);
    expect(notesText(notes, "1.3.0")).toBe("Release notes for 1.3.0:\n  Fixes.\n  More fixes.");
    expect(await releaseNotes({ version: "1.3.0", fetch: async () => new Response("", { status: 404 }) })).toBeUndefined();
    expect(notesText(undefined, "1.3.0")).toBe("No release notes could be read for 1.3.0; see https://github.com/PrepLabsAI/AgentX/releases/tag/v1.3.0");
  });

  it("shows at most 40 lines of notes, then where the rest are", () => {
    const text = notesText({ text: Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n"), url: "https://example.test/notes" }, "1.3.0");
    expect(text.split("\n")).toHaveLength(42);
    expect(text.split("\n").at(-1)).toBe("  (10 more lines at https://example.test/notes)");
  });

  it("refuses a prerelease target unless it came from --release <dir> (ruling F31)", () => {
    expect(() => refusePrereleaseTarget("1.3.0-rc.1", { fromReleaseDir: false })).toThrow("release 1.3.0-rc.1 is a prerelease; agentx upgrade moves an environment only to published releases (x.y.z). Upgrade to a published release, or pass --release <dir> to test a prerelease");
    expect(() => refusePrereleaseTarget("1.3.0-rc.1", { fromReleaseDir: true })).not.toThrow();
    expect(() => refusePrereleaseTarget("1.3.0", { fromReleaseDir: false })).not.toThrow();
  });
});
