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
const noOperator = { "agentx-staging-access": { OperatorPrincipalArn: "" } };
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
    const answers = await upgradeAnswers({ settings: oidc, stacks: stacks({ ...noOperator, "agentx-staging-control-plane": { ...controlPlane, AdminClaim: "groups", AdminValues: "[\"eng-admins\"]" } }) });
    expect(answers.identity).toEqual({ mode: "oidc", issuer: "https://idp.example.com", audience: "agentx", clientId: "cli", adminClaim: "groups", adminValues: ["eng-admins"] });
  });

  it("passes the testing-only image overrides, and the permission boundary from the settings", async () => {
    const settings = { ...SETTINGS, access: { artifactBucket: "b", cloudFormationRoleArn: "arn:aws:iam::123456789012:role/cfn", operatorRoleArn: "arn:aws:iam::123456789012:role/op", pullThroughPrefix: "agentx-staging", permissionsBoundaryArn: "arn:aws:iam::123456789012:policy/company-boundary" } };
    const answers = await upgradeAnswers({ settings, stacks: stacks({ ...noOperator, "agentx-staging-control-plane": controlPlane }), images: { worker: `w@sha256:${"b".repeat(64)}` } });
    expect(answers.images).toEqual({ worker: `w@sha256:${"b".repeat(64)}` });
    expect(answers.permissionsBoundaryArn).toBe("arn:aws:iam::123456789012:policy/company-boundary");
  });

  it("refuses when the control-plane stack is gone or lacks the GitHub App", async () => {
    await expect(upgradeAnswers({ settings: SETTINGS, stacks: stacks({}) })).rejects.toThrow("stack agentx-staging-control-plane does not exist; agentx doctor says what else is missing");
    await expect(upgradeAnswers({ settings: SETTINGS, stacks: stacks({ "agentx-staging-control-plane": {} }) })).rejects.toThrow("stack agentx-staging-control-plane has no GitHubAppId parameter");
  });

  it("keeps an empty GitHub App id: the control plane deployed before the app reads it from the secret", async () => {
    const answers = await upgradeAnswers({ settings: SETTINGS, stacks: stacks({ ...noOperator, "agentx-staging-control-plane": { ...controlPlane, GitHubAppId: "" } }) });
    expect(answers.github).toMatchObject({ appId: "", privateKeySecretArn: KEY_ARN });
  });

  it("refuses a GitHub App id that is not a number, or a private key that is not an ARN", async () => {
    await expect(upgradeAnswers({ settings: SETTINGS, stacks: stacks({ ...noOperator, "agentx-staging-control-plane": { ...controlPlane, GitHubAppId: "12a" } }) })).rejects.toThrow("stack agentx-staging-control-plane's GitHubAppId parameter is not a GitHub App id (a number); run agentx doctor, and agentx init --resume if the install never finished");
    await expect(upgradeAnswers({ settings: SETTINGS, stacks: stacks({ ...noOperator, "agentx-staging-control-plane": { ...controlPlane, GitHubAppPrivateKeySecretArn: "agentx/staging/github-app" } }) })).rejects.toThrow("stack agentx-staging-control-plane's GitHubAppPrivateKeySecretArn parameter is not an ARN; run agentx doctor, and agentx init --resume if the install never finished");
  });

  it("refuses when the access stack the settings name is gone, instead of dropping the operator principal", async () => {
    await expect(upgradeAnswers({ settings: SETTINGS, stacks: stacks({ "agentx-staging-control-plane": controlPlane }) })).rejects.toThrow("stack agentx-staging-access does not exist; agentx doctor says what else is missing");
    const answers = await upgradeAnswers({ settings: SETTINGS, stacks: stacks({ ...noOperator, "agentx-staging-control-plane": controlPlane }) });
    expect(answers).not.toHaveProperty("operatorPrincipalArn");
  });

  it("refuses your own OIDC provider's AdminValues when it is not JSON or an empty list, and a missing AdminClaim", async () => {
    const oidc = { ...SETTINGS, identity: { mode: "oidc" as const, issuer: "https://idp.example.com", audience: "agentx", clientId: "cli" } };
    const refusal = "stack agentx-staging-control-plane's AdminValues parameter is not a list of admin values; fix it in the CloudFormation console, then run agentx upgrade again";
    await expect(upgradeAnswers({ settings: oidc, stacks: stacks({ ...noOperator, "agentx-staging-control-plane": { ...controlPlane, AdminValues: "eng-admins" } }) })).rejects.toThrow(refusal);
    await expect(upgradeAnswers({ settings: oidc, stacks: stacks({ ...noOperator, "agentx-staging-control-plane": { ...controlPlane, AdminValues: "[]" } }) })).rejects.toThrow(refusal);
    const noClaim: Record<string, string> = { ...controlPlane };
    delete noClaim.AdminClaim;
    await expect(upgradeAnswers({ settings: oidc, stacks: stacks({ ...noOperator, "agentx-staging-control-plane": noClaim }) })).rejects.toThrow("stack agentx-staging-control-plane has no AdminClaim parameter; run agentx doctor, and agentx init --resume if the install never finished");
  });

  it("passes the slack image override alone, and no images at all without overrides", async () => {
    const slack = await upgradeAnswers({ settings: SETTINGS, stacks: stacks({ ...noOperator, "agentx-staging-control-plane": controlPlane }), images: { slack: `s@sha256:${"c".repeat(64)}` } });
    expect(slack.images).toEqual({ slack: `s@sha256:${"c".repeat(64)}` });
    for (const images of [undefined, {}]) {
      const none = await upgradeAnswers({ settings: SETTINGS, stacks: stacks({ ...noOperator, "agentx-staging-control-plane": controlPlane }), ...(images === undefined ? {} : { images }) });
      expect(none).not.toHaveProperty("images");
    }
  });
});

describe("the target release", () => {
  it("orders versions, with a prerelease before its release", () => {
    expect(compareVersions("1.2.3", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareVersions("1.3.0-rc.1", "1.3.0")).toBeLessThan(0);
    expect(compareVersions("1.3.0", "1.3.0")).toBe(0);
    expect(compareVersions("1.3.0-rc.2", "1.3.0-rc.10")).toBeLessThan(0);
  });

  it("refuses anything that is not a release version, instead of calling it older", () => {
    for (const version of ["unversioned", "1.2", "1.2.x", "1.2.3+build.5", "v1.2.3", ""]) {
      expect(() => compareVersions(version, "1.2.3")).toThrow(`"${version}" is not a release version (x.y.z); use a published release version such as 1.4.0`);
      expect(() => compareVersions("1.2.3", version)).toThrow(`"${version}" is not a release version`);
    }
    expect(() => upgradeDirection("staging", "unversioned", "1.3.0")).toThrow("environment staging's settings record version \"unversioned\", not a release, so agentx upgrade cannot tell whether 1.3.0 is older; agentx upgrade works only on environments agentx init installed");
  });

  it("allows the same release (a re-run) and a newer one, and refuses an older one (question 3)", () => {
    expect(upgradeDirection("staging", "1.2.3", "1.2.3")).toBe("same");
    expect(upgradeDirection("staging", "1.2.3", "1.3.0")).toBe("newer");
    expect(() => upgradeDirection("staging", "1.3.0", "1.2.3")).toThrow("release 1.2.3 is older than 1.3.0, which environment staging runs; agentx upgrade never moves an environment back");
  });

  it("reads the release's notes from GitHub, and says where to look when it cannot", async () => {
    const fetched: string[] = [];
    const notes = await releaseNotes({ version: "1.3.0", fetch: (async (url: string) => { fetched.push(url); return new Response(JSON.stringify({ body: "Fixes.\nMore fixes.", html_url: "https://github.com/PrepLabsAI/Rovara/releases/tag/v1.3.0" }), { status: 200 }); }) as never });
    expect(fetched).toEqual(["https://api.github.com/repos/PrepLabsAI/Rovara/releases/tags/v1.3.0"]);
    expect(notesText(notes, "1.3.0")).toBe("Release notes for 1.3.0:\n  Fixes.\n  More fixes.");
    expect(await releaseNotes({ version: "1.3.0", fetch: async () => new Response("", { status: 404 }) })).toBeUndefined();
    expect(notesText(undefined, "1.3.0")).toBe("No release notes could be read for 1.3.0; see https://github.com/PrepLabsAI/Rovara/releases/tag/v1.3.0");
  });

  it("strips control characters from the notes, keeping lines, and says so plainly when they are empty", () => {
    expect(notesText({ text: "\u001b[31mRed\u001b[0m fix\u0007\r\nTab\there\u0000\n\u0085next", url: "https://example.test/notes" }, "1.3.0")).toBe("Release notes for 1.3.0:\n  Red fix\n  Tab here\n  next");
    expect(notesText({ text: " \n\u001b[0m\n", url: "https://example.test/notes" }, "1.3.0")).toBe("Release 1.3.0 has no release notes; see https://example.test/notes");
  });

  it("shows at most 40 lines of notes, then where the rest are", () => {
    const text = notesText({ text: Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n"), url: "https://example.test/notes" }, "1.3.0");
    expect(text.split("\n")).toHaveLength(42);
    expect(text.split("\n").at(-1)).toBe("  (10 more lines at https://example.test/notes)");
  });

  it("refuses every prerelease target, even one from --release <dir>, as init does (ruling F31, amended)", () => {
    expect(() => refusePrereleaseTarget("1.3.0-rc.1")).toThrow("release 1.3.0-rc.1 is a prerelease; agentx upgrade moves an environment only to published releases (x.y.z), because the environment settings record only x.y.z and a prerelease would fail after every stack deployed. Pass --release <dir> with a published release, or upgrade to a published version");
    expect(() => refusePrereleaseTarget("1.3.0")).not.toThrow();
  });
});
