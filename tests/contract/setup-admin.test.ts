import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { AdminAddUserToGroupCommand, AdminCreateUserCommand, type AdminGetUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { tokenStoreKey, type LoginOptions } from "../../packages/cli/src/auth.js";
import { ensureCognitoAdmin } from "../../packages/cli/src/setup/admin-user.js";
import { openAdminSession, tokenClaimValues, userPoolId } from "../../packages/cli/src/setup/admin-session.js";
import { cognitoAdmin } from "../../packages/cli/src/setup/services.js";
import { adminUserStep } from "../../packages/cli/src/init/finish-steps.js";
import type { EnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { initContext, progressHandle, sampleAnswers, scriptedPrompter, T0, type TestInitContext } from "../support/init-fakes.js";
import type { MemoryParameterStore } from "../support/memory-parameter-store.js";
import { ADMIN_EMAIL, CONTROL_PLANE, accessToken, fakeCognito, fakeControlPlane, memoryTokenStore, setupServices } from "../support/setup-fakes.js";

const cognitoSettings = {
  schemaVersion: 1, env: "staging", account: "123456789012", region: "us-east-1", engine: "templates", version: "1.2.3", naming: "environment",
  stacks: { foundation: "agentx-staging-foundation", runtime: "agentx-staging-runtime", "control-plane": "agentx-staging-control-plane", slack: "agentx-staging-slack" },
  controlPlaneUrl: CONTROL_PLANE,
  identity: { mode: "cognito", issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbCdEf123", audience: "client123", clientId: "client123" },
  models: { orchestrator: "us.anthropic.claude-sonnet-4-6", classifier: "amazon.nova-lite-v1:0", worker: "amazon.nova-pro-v1:0" },
  updatedAt: "2026-09-27T00:00:00.000Z",
} as EnvironmentSettings;
const oidcSettings = { ...cognitoSettings, identity: { mode: "oidc", issuer: "https://login.example.com", audience: "agentx", clientId: "cli" } } as EnvironmentSettings;
const key = tokenStoreKey(cognitoSettings.identity);
const now = () => T0;
const SIGN_IN_URL = "https://auth.example.test/authorize?client_id=client123&state=s";

/** A login that plays the browser step: it hands the sign-in address to openBrowser, as loginWithPkce does. */
function loginThatOpens(token: string, seen: LoginOptions[] = []) {
  return async (options: LoginOptions) => {
    seen.push(options);
    await options.openBrowser?.(SIGN_IN_URL);
    return { accessToken: token, expiresAt: T0 + 3_600_000 };
  };
}

describe("the Cognito admin user (FR-018 step 7)", () => {
  it("creates the user, adds it to agentx-admin and says the temporary password comes by email", async () => {
    const cognito = fakeCognito();
    const lines: string[] = [];
    expect(await ensureCognitoAdmin({ cognito, poolId: "us-east-1_AbCdEf123", email: ADMIN_EMAIL, write: (line) => lines.push(line) })).toEqual({ created: true });
    expect(cognito.created).toEqual([ADMIN_EMAIL]);
    expect(cognito.grouped).toEqual([`${ADMIN_EMAIL}:agentx-admin`]);
    expect(lines.join("\n")).toContain(`Cognito emailed a temporary password to ${ADMIN_EMAIL}`);
  });

  it("never creates an existing user again, and still adds it to the group (Review Focus 1)", async () => {
    const cognito = fakeCognito({ [ADMIN_EMAIL]: "FORCE_CHANGE_PASSWORD" });
    const lines: string[] = [];
    expect(await ensureCognitoAdmin({ cognito, poolId: "p", email: ADMIN_EMAIL, write: (line) => lines.push(line) })).toEqual({ created: false });
    expect(cognito.created).toEqual([]);
    expect(cognito.grouped).toEqual([`${ADMIN_EMAIL}:agentx-admin`]);
    expect(lines.join("\n")).toContain("use the temporary password from the first email");
  });

  it("reads the pool id from the issuer", () => {
    expect(userPoolId(cognitoSettings)).toBe("us-east-1_AbCdEf123");
  });

  it("refuses an issuer that does not end in a user pool id, saying where to look", () => {
    expect(() => userPoolId(oidcSettings)).toThrow("does not end in a Cognito user pool id; check /agentx/<env>/settings");
  });
});

describe("the Cognito client wrapper", () => {
  function recordingClient(answer: (command: unknown) => unknown) {
    const sent: unknown[] = [];
    return { sent, send: async (command: unknown) => { sent.push(command); return answer(command); } };
  }

  it("asks Cognito to email the temporary password, and never sets or suppresses one itself", async () => {
    const client = recordingClient(() => ({}));
    await cognitoAdmin(client).createUser("us-east-1_AbCdEf123", ADMIN_EMAIL);
    const command = client.sent[0] as AdminCreateUserCommand;
    expect(command).toBeInstanceOf(AdminCreateUserCommand);
    expect(command.input).toEqual({
      UserPoolId: "us-east-1_AbCdEf123", Username: ADMIN_EMAIL, DesiredDeliveryMediums: ["EMAIL"],
      UserAttributes: [{ Name: "email", Value: ADMIN_EMAIL }, { Name: "email_verified", Value: "true" }],
    });
  });

  it("reads a user's status, and treats a missing user as undefined", async () => {
    const present = recordingClient(() => ({ UserStatus: "CONFIRMED" }));
    expect(await cognitoAdmin(present).userStatus("p", ADMIN_EMAIL)).toBe("CONFIRMED");
    expect((present.sent[0] as AdminGetUserCommand).input).toEqual({ UserPoolId: "p", Username: ADMIN_EMAIL });
    const absent = recordingClient(() => { throw Object.assign(new Error("User does not exist."), { name: "UserNotFoundException" }); });
    expect(await cognitoAdmin(absent).userStatus("p", ADMIN_EMAIL)).toBeUndefined();
    const denied = recordingClient(() => { throw Object.assign(new Error("not allowed"), { name: "AccessDeniedException" }); });
    await expect(cognitoAdmin(denied).userStatus("p", ADMIN_EMAIL)).rejects.toThrow("not allowed");
  });

  it("adds the user to the group by name", async () => {
    const client = recordingClient(() => ({}));
    await cognitoAdmin(client).addToGroup("p", ADMIN_EMAIL, "agentx-admin");
    expect(client.sent[0]).toBeInstanceOf(AdminAddUserToGroupCommand);
    expect((client.sent[0] as AdminAddUserToGroupCommand).input).toEqual({ UserPoolId: "p", Username: ADMIN_EMAIL, GroupName: "agentx-admin" });
  });
});

describe("the admin session", () => {
  it("reuses a stored token that has not expired, after the admin route accepts it", async () => {
    const token = accessToken({ "cognito:groups": ["agentx-admin"] });
    const plane = fakeControlPlane();
    let logins = 0;
    const session = await openAdminSession({
      settings: cognitoSettings, now, write: () => undefined,
      services: { tokenStore: memoryTokenStore({ [key]: { accessToken: token, expiresAt: T0 + 3_600_000 } }), fetch: plane.fetch, login: async () => { logins += 1; throw new Error("not expected"); } },
    });
    expect(session).toEqual({ controlPlaneUrl: CONTROL_PLANE, accessToken: token });
    expect(logins).toBe(0);
    expect(plane.requests).toEqual([{ method: "GET", path: "/v1/admin/credentials", token }]);
  });

  it("signs in again when the stored token expired (Review Focus 2)", async () => {
    const fresh = accessToken({ "cognito:groups": ["agentx-admin"] });
    let logins = 0;
    const session = await openAdminSession({
      settings: cognitoSettings, now, write: () => undefined,
      services: { tokenStore: memoryTokenStore({ [key]: { accessToken: "old", expiresAt: T0 - 1 } }), fetch: fakeControlPlane().fetch, login: async () => { logins += 1; return { accessToken: fresh, expiresAt: T0 + 3_600_000 }; } },
    });
    expect(logins).toBe(1);
    expect(session.accessToken).toBe(fresh);
  });

  it("with no browser (--no-browser), opens nothing and prints the sign-in address (F12)", async () => {
    const token = accessToken({ "cognito:groups": ["agentx-admin"] });
    const lines: string[] = [];
    const seen: LoginOptions[] = [];
    await openAdminSession({
      settings: cognitoSettings, now, write: (line) => lines.push(line),
      services: { tokenStore: memoryTokenStore(), fetch: fakeControlPlane().fetch, login: loginThatOpens(token, seen) },
    });
    // An openBrowser is always passed, so loginWithPkce never falls back to the system browser.
    expect(seen[0]?.openBrowser).toBeTypeOf("function");
    expect(lines).toContain(SIGN_IN_URL);
    expect(lines.join("\n")).toContain("Open this address in your browser and sign in as the admin user");
    expect(lines.join("\n")).not.toContain(token);
  });

  it("with a browser, opens the sign-in address and prints it too", async () => {
    const token = accessToken({ "cognito:groups": ["agentx-admin"] });
    const lines: string[] = [];
    const opened: string[] = [];
    await openAdminSession({
      settings: cognitoSettings, now, write: (line) => lines.push(line), openBrowser: async (url) => { opened.push(url); return true; },
      services: { tokenStore: memoryTokenStore(), fetch: fakeControlPlane().fetch, login: loginThatOpens(token) },
    });
    expect(opened).toEqual([SIGN_IN_URL]);
    expect(lines).toContain(SIGN_IN_URL);
    expect(lines.join("\n")).toContain("A browser opens the AgentX sign-in page. Sign in as the admin user");
    expect(lines.join("\n")).not.toContain(token);
  });

  it("stops with what to do when the signed-in user is not an administrator (Review Focus 2)", async () => {
    const token = accessToken({ "cognito:groups": [] });
    const plane = fakeControlPlane();
    plane.forbidden.add(token);
    await expect(openAdminSession({
      settings: cognitoSettings, now, write: () => undefined,
      services: { tokenStore: memoryTokenStore(), fetch: plane.fetch, login: async () => ({ accessToken: token, expiresAt: T0 + 3_600_000 }) },
    })).rejects.toThrow("you signed in as someone who is not an AgentX administrator; sign out of the AgentX sign-in page in your browser, then run agentx init again and sign in as the admin user");
  });

  it("decides a refusal by the error code, not by words in the message (F11)", async () => {
    const token = accessToken({ "cognito:groups": ["agentx-admin"] });
    const wordy: typeof fetch = async () => new Response(JSON.stringify({ error: { code: "CONFIG_INVALID", message: "administrator settings are FORBIDDEN here" } }), { status: 400 });
    const failure = openAdminSession({
      settings: cognitoSettings, now, write: () => undefined,
      services: { tokenStore: memoryTokenStore(), fetch: wordy, login: async () => ({ accessToken: token, expiresAt: T0 + 3_600_000 }) },
    });
    await expect(failure).rejects.toThrow("CONFIG_INVALID: administrator settings are FORBIDDEN here");
    await expect(failure).rejects.not.toThrow("not an AgentX administrator");
  });

  it("refuses your own OIDC provider's token without the admin claim, naming it (FR-021)", async () => {
    const token = accessToken({ groups: ["engineering"] });
    await expect(openAdminSession({
      settings: oidcSettings, now, write: () => undefined, adminClaim: { claim: "groups", values: ["agentx-admins"] },
      services: { tokenStore: memoryTokenStore(), fetch: fakeControlPlane().fetch, login: async () => ({ accessToken: token, expiresAt: T0 + 3_600_000 }) },
    })).rejects.toThrow('your sign-in token\'s "groups" claim has none of agentx-admins (it has engineering); add yourself to one of them in your identity provider, then run agentx init again');
  });

  it("reads claim values from a string or a list, and from no claim at all", () => {
    expect(tokenClaimValues(accessToken({ groups: "a" }), "groups")).toEqual(["a"]);
    expect(tokenClaimValues(accessToken({ groups: ["a", "b"] }), "groups")).toEqual(["a", "b"]);
    expect(tokenClaimValues(accessToken({}), "groups")).toEqual([]);
    expect(tokenClaimValues("not-a-jwt", "groups")).toEqual([]);
  });
});

describe("the admin-user init step", () => {
  let context: TestInitContext | undefined;
  afterEach(async () => { if (context !== undefined) await rm(context.home, { recursive: true, force: true }); });

  it("creates the Cognito admin from the asked email, signs in, and records the admin", async () => {
    const cognito = fakeCognito();
    context = initContext({ prompter: scriptedPrompter([ADMIN_EMAIL]), setup: setupServices({ cognito }) });
    (context.store as MemoryParameterStore).values.set("/agentx/staging/settings", JSON.stringify(cognitoSettings));
    const progress = progressHandle();
    expect(await adminUserStep().run(context, progress)).toEqual({ status: "done", note: `admin ${ADMIN_EMAIL}` });
    expect(cognito.created).toEqual([ADMIN_EMAIL]);
    expect(progress.value().admin).toEqual({ username: ADMIN_EMAIL, mode: "cognito" });
    expect(context.lines.join("\n")).toContain("A browser opens the AgentX sign-in page. Sign in as");
  });

  it("does not ask again on a rerun that already recorded the admin", async () => {
    const cognito = fakeCognito({ [ADMIN_EMAIL]: "CONFIRMED" });
    context = initContext({ prompter: scriptedPrompter([]), setup: setupServices({ cognito }) });
    (context.store as MemoryParameterStore).values.set("/agentx/staging/settings", JSON.stringify(cognitoSettings));
    const progress = progressHandle({ ...progressHandle().value(), admin: { username: ADMIN_EMAIL, mode: "cognito" } });
    await adminUserStep().run(context, progress);
    expect(cognito.created).toEqual([]);
    // ensureCognitoAdmin did not run at all: it always adds the user to the group.
    expect(cognito.grouped).toEqual([]);
  });

  it("takes the email from --admin-email without asking", async () => {
    const cognito = fakeCognito();
    context = initContext({ prompter: scriptedPrompter([]), setup: setupServices({ cognito }), flags: { adminEmail: ADMIN_EMAIL } });
    (context.store as MemoryParameterStore).values.set("/agentx/staging/settings", JSON.stringify(cognitoSettings));
    await adminUserStep().run(context, progressHandle());
    expect(cognito.created).toEqual([ADMIN_EMAIL]);
  });

  it("records your own OIDC admin by the token's email claim, not a placeholder (F24)", async () => {
    const cognito = fakeCognito();
    const token = accessToken({ sub: "00u1abcd", email: "bob@example.com", groups: ["agentx-admins"] });
    context = initContext({
      answers: sampleAnswers({ identity: { mode: "oidc", issuer: "https://login.example.com", audience: "agentx", clientId: "cli", adminClaim: "groups", adminValues: ["agentx-admins"] } }),
      setup: setupServices({ cognito, login: async () => ({ accessToken: token, expiresAt: T0 + 3_600_000 }) }),
    });
    (context.store as MemoryParameterStore).values.set("/agentx/staging/settings", JSON.stringify(oidcSettings));
    const progress = progressHandle();
    expect(await adminUserStep().run(context, progress)).toEqual({ status: "done", note: "admin bob@example.com signed in with your OIDC provider" });
    expect(progress.value().admin).toEqual({ username: "bob@example.com", mode: "oidc" });
    expect(cognito.created).toEqual([]);
    expect(context.lines.join("\n")).not.toContain(token);
  });

  it("falls back to the token's sub claim when it carries no email (F24)", async () => {
    const token = accessToken({ sub: "00u1abcd", groups: ["agentx-admins"] });
    context = initContext({
      answers: sampleAnswers({ identity: { mode: "oidc", issuer: "https://login.example.com", audience: "agentx", clientId: "cli", adminClaim: "groups", adminValues: ["agentx-admins"] } }),
      setup: setupServices({ login: async () => ({ accessToken: token, expiresAt: T0 + 3_600_000 }) }),
    });
    (context.store as MemoryParameterStore).values.set("/agentx/staging/settings", JSON.stringify(oidcSettings));
    const progress = progressHandle();
    await adminUserStep().run(context, progress);
    expect(progress.value().admin).toEqual({ username: "00u1abcd", mode: "oidc" });
  });

  it("refuses to run before the environment has settings, saying what to do", async () => {
    context = initContext({ prompter: scriptedPrompter([]) });
    await expect(adminUserStep().run(context, progressHandle())).rejects.toThrow("environment staging has no settings yet; the Slack service step must finish first, so run agentx init again");
  });
});
