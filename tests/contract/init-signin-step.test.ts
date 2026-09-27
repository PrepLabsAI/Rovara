// The developer-signin init step (spec 025 FR-044): the last agentx init step (R9 corrected by
// F15). Nothing here reaches AWS, Slack or an identity provider.
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { developerSignInStep } from "../../packages/cli/src/init/signin-step.js";
import { emptyProgress } from "../../packages/cli/src/init/install-state.js";
import { readSignInSettings } from "../../packages/cli/src/signin/settings.js";
import { stagingSettings } from "../support/environment-fixtures.js";
import { SIGN_IN_PARAMETERS, fakeCloudFormation } from "../support/fake-cloudformation.js";
import {
  T0, fakeSlackApi, initContext, memoryInitSecrets, progressHandle, scriptedPrompter, storeWithInitLock, TEST_BOT_TOKEN, TEST_SIGNING_SECRET,
} from "../support/init-fakes.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });
const CLIENT_SECRET = "fedcba9876543210fedcba9876543210";
const installed = { ...stagingSettings, controlPlaneUrl: "https://abc123.execute-api.us-east-1.amazonaws.com", access: { artifactBucket: "b", cloudFormationRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-cloudformation", operatorRoleArn: "arn:aws:iam::123456789012:role/agentx-staging-operator", pullThroughPrefix: "agentx-staging" } };
const withScopes = fakeSlackApi({ authTest: async () => ({ ok: true, team_id: "T0TEAM", user_id: "U0BOT", bot_id: "B0BOT", scopes: ["channels:read", "groups:read", "im:write", "users:read", "users:read.email"] }) });

async function context(prompts: Array<string | boolean>, finalStatus?: string) {
  const cloudFormation = fakeCloudFormation({ parameters: SIGN_IN_PARAMETERS, ...(finalStatus === undefined ? {} : { finalStatus }) });
  const secrets = memoryInitSecrets({ "agentx/staging/slack": JSON.stringify({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN }) });
  // F13: InitContext.store is a ParameterStore, which has no `calls`; a MemoryParameterStore made
  // here (rather than read back off ctx.store) keeps its concrete type, so tests can inspect calls.
  const store = storeWithInitLock();
  const ctx = initContext({ prompter: scriptedPrompter(prompts), secrets, cloudFormation, store });
  homes.push(ctx.home);
  await writeEnvironmentSettings(ctx.store, installed);
  const progress = progressHandle({ ...emptyProgress("staging", T0), slack: { appId: "A0APP", teamId: "T0TEAM", botUserId: "U0BOT" } });
  return { ctx, store, cloudFormation, progress };
}

describe("the developer-signin init step (FR-044)", () => {
  it("defaults to Slack, stores the client credentials, records the team and turns Slack sign-in on", async () => {
    const { ctx, cloudFormation, progress } = await context(["", "1111111111.2222222222222", CLIENT_SECRET, true]);
    expect(await developerSignInStep({ slack: withScopes }).run(ctx, progress)).toEqual({ status: "done", note: "developer sign-in: Slack" });
    expect(cloudFormation.parameters).toMatchObject({ DeveloperSignInSlack: "enabled", SlackTeamId: "T0TEAM" });
    expect(await readSignInSettings(ctx.store, "staging")).toMatchObject({ slack: true });
    expect(ctx.lines).toContain("Developers sign in with: npx @charterarc/agentx login https://abc123.execute-api.us-east-1.amazonaws.com");
    expect(ctx.lines.join("\n")).not.toContain(CLIENT_SECRET);
  });

  it("holds the lock the step runner already holds, and never takes it again", async () => {
    const { ctx, store, progress } = await context(["", "1111111111.2222222222222", CLIENT_SECRET, true]);
    await developerSignInStep({ slack: withScopes }).run(ctx, progress);
    expect(store.calls.filter((call) => call.name.endsWith("/lock") && call.op !== "get")).toEqual([]);
  });

  it("refuses a bot token of another workspace than the install's", async () => {
    const { ctx, progress } = await context([""]);
    const otherTeam = fakeSlackApi({ authTest: async () => ({ ok: true, team_id: "T0OTHER", user_id: "U0BOT", bot_id: "B0BOT", scopes: [] }) });
    await expect(developerSignInStep({ slack: otherTeam }).run(ctx, progress)).rejects.toThrow("the stored bot token belongs to Slack workspace T0OTHER, but this install uses T0TEAM; nothing was saved");
  });

  it("puts the Slack secret back as it was when the stack update rolls back (Task 12 fix round 1)", async () => {
    const { ctx, progress } = await context(["", "1111111111.2222222222222", CLIENT_SECRET, true], "UPDATE_ROLLBACK_COMPLETE");
    const before = ctx.secrets.values.get("agentx/staging/slack");
    await expect(developerSignInStep({ slack: withScopes }).run(ctx, progress)).rejects.toThrow("the previous client credentials were put back in agentx/staging/slack");
    expect(ctx.secrets.values.get("agentx/staging/slack")).toBe(before);
    expect(await readSignInSettings(ctx.store, "staging")).toBeUndefined();
  });

  it("is done at once when sign-in was already set up (a re-run after a crash)", async () => {
    const { ctx, cloudFormation, progress } = await context([]);
    await ctx.store.put("/agentx/staging/signin", JSON.stringify({ schemaVersion: 1, env: "staging", slack: true, updatedAt: "2026-09-27T00:00:00.000Z", updatedBy: "x" }));
    expect(await developerSignInStep({ slack: withScopes }).run(ctx, progress)).toEqual({ status: "done", note: "developer sign-in was already set up" });
    expect(cloudFormation.calls).toEqual([]);
  });
});
