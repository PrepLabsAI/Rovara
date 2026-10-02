// Spec 048 FR-028 and FR-065: the install name, the GitHub owner and the app name, checked before
// anything is created.
import { describe, expect, it } from "vitest";
import { environmentStackName } from "@agentx/contracts";
import { clashChecks } from "../../packages/cli/src/init/clash-checks.js";
import { githubAppSlug } from "../../packages/cli/src/init/github-app.js";
import { fakeGitHubApi, sampleAnswers } from "../support/init-fakes.js";

const nothing = { status: async () => undefined };
const free = async () => false;

describe("clash checks", () => {
  it("passes a free name, an existing owner of the right type and a free app name", async () => {
    const checks = await clashChecks({ answers: sampleAnswers(), stackStatus: nothing, github: fakeGitHubApi(), audience: "page", installUsed: free });
    expect(checks.map((check) => [check.label, check.ok])).toEqual([["Install name", true], ["GitHub owner", true], ["App name", true]]);
  });

  it("refuses an install name that already has a stack here, naming the stacks only in the details", async () => {
    const stack = environmentStackName("staging", "access");
    const [name] = await clashChecks({ answers: sampleAnswers(), stackStatus: { status: async (each) => (each === stack ? "CREATE_COMPLETE" : undefined) }, github: fakeGitHubApi(), audience: "page", installUsed: free });
    expect(name).toEqual({ label: "Install name", ok: false, detail: "This AWS account and region already have an AgentX install named staging. Choose another install name.", technical: stack });
  });

  it("does not attach the stack name as a separate terminal detail", async () => {
    const stack = environmentStackName("staging", "access");
    const [name] = await clashChecks({ answers: sampleAnswers(), stackStatus: { status: async (each) => (each === stack ? "CREATE_COMPLETE" : undefined) }, github: fakeGitHubApi(), audience: "terminal", installUsed: free });
    expect(name).toEqual({ label: "Install name", ok: false, detail: "environment staging already has stacks or settings in this account and region; choose another --env" });
  });

  it("refuses an owner GitHub does not have, and the wrong owner type", async () => {
    const missing = await clashChecks({ answers: sampleAnswers(), stackStatus: nothing, github: { ...fakeGitHubApi(), owner: async () => undefined }, audience: "page", installUsed: free });
    expect(missing[1]).toEqual({ label: "GitHub owner", ok: false, detail: "GitHub has no organization or user named acme. Check the spelling." });
    const wrongType = await clashChecks({ answers: sampleAnswers(), stackStatus: nothing, github: fakeGitHubApi({ ownerType: "User" }), audience: "page", installUsed: free });
    expect(wrongType[1]).toEqual({ label: "GitHub owner", ok: false, detail: "acme is a personal GitHub account, not an organization. Change the answer." });
  });

  it("Review Focus 3: an unreachable GitHub is could not check, never no such owner", async () => {
    const offline = { ...fakeGitHubApi(), owner: async () => { throw new Error("GitHub owner lookup failed with HTTP 403"); } };
    const [, owner] = await clashChecks({ answers: sampleAnswers(), stackStatus: nothing, github: offline, audience: "page", installUsed: free });
    expect(owner).toEqual({ label: "GitHub owner", ok: false, detail: "AgentX could not reach GitHub to check acme. Check your network, then check again.", technical: "GitHub owner lookup failed with HTTP 403" });
    expect(owner?.detail).not.toMatch(/has no organization/);
  });

  it("refuses an app name too long for GitHub or Slack, and one GitHub already has", async () => {
    const long = sampleAnswers({ github: { account: "acme", accountType: "organization", appName: "x".repeat(35) } });
    expect((await clashChecks({ answers: long, stackStatus: nothing, github: fakeGitHubApi(), audience: "page", installUsed: free }))[2]?.ok).toBe(false);
    const taken = await clashChecks({ answers: sampleAnswers(), stackStatus: nothing, github: { ...fakeGitHubApi(), appBySlug: async () => ({ owner: { login: "someone-else" } }) }, audience: "page", installUsed: free });
    expect(taken[2]).toEqual({ label: "App name", ok: false, detail: "GitHub already has an app named AgentX acme (staging). Choose another app name.", technical: "agentx-acme-staging" });
  });

  it("Fix round 1: a failed stack read is could not check the install name, for the page", async () => {
    const broken = { status: async () => { throw new Error("AccessDenied: not authorized to perform cloudformation:DescribeStacks"); } };
    const [name] = await clashChecks({ answers: sampleAnswers(), stackStatus: broken, github: fakeGitHubApi(), audience: "page", installUsed: free });
    expect(name).toEqual({
      label: "Install name", ok: false,
      detail: "AgentX could not check whether the install name is free. Check your access to AWS, then check again.",
      technical: "AccessDenied: not authorized to perform cloudformation:DescribeStacks",
    });
  });

  it("Fix round 1: a failed installUsed read is could not check the install name, for the terminal", async () => {
    const broken = async () => { throw new Error("AccessDenied: not authorized to read the parameter"); };
    const [name] = await clashChecks({ answers: sampleAnswers(), stackStatus: nothing, github: fakeGitHubApi(), audience: "terminal", installUsed: broken });
    expect(name).toEqual({
      label: "Install name", ok: false,
      detail: "could not check whether environment staging is free (AccessDenied: not authorized to read the parameter); check your AWS access and run agentx init again",
    });
  });

  it("names the slug as GitHub makes it", () => {
    expect(githubAppSlug("AgentX acme (staging)")).toBe("agentx-acme-staging");
    expect(githubAppSlug("Our  AgentX!")).toBe("our-agentx");
  });
});
