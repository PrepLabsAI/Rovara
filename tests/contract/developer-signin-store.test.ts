// tests/contract/developer-signin-store.test.ts
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import { sha256Hex } from "../../packages/broker/src/developer/tokens.js";
import { T0 } from "../support/developer-fakes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const verifier = "v".repeat(64);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const redirect = "http://127.0.0.1:49152/callback";
const developerId = "a".repeat(64);

let db: FakeDynamoDb;
let clock: number;
let store: DeveloperSignInStore;
beforeEach(() => {
  db = new FakeDynamoDb();
  clock = T0;
  store = new DeveloperSignInStore({ documentClient: db, tableName: "signin", now: () => clock });
});

describe("authorization requests", () => {
  it("expire after 10 minutes and are consumed once, for the method chosen", async () => {
    const request = await store.createAuthRequest({ clientRedirectUri: redirect, clientState: "cs", codeChallenge: challenge, nonce: "n1" });
    expect(request.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(db.get(`AUTHREQ#${request.id}`, "META")).toMatchObject({ expiresAt: T0 / 1000 + 600 });
    await store.chooseMethod(request.id, "slack");
    expect(await store.consumeAuthRequest(request.id, "oidc")).toBeUndefined();
    expect(await store.consumeAuthRequest(request.id, "slack")).toMatchObject({ clientState: "cs", nonce: "n1" });
    expect(await store.consumeAuthRequest(request.id, "slack")).toBeUndefined();
  });

  it("are gone once expired", async () => {
    const request = await store.createAuthRequest({ clientRedirectUri: redirect, clientState: "cs", codeChallenge: challenge, nonce: "n1" });
    clock = T0 + 601_000;
    expect(await store.getAuthRequest(request.id)).toBeUndefined();
    expect(await store.chooseMethod(request.id, "slack")).toBeUndefined();
  });
});

describe("developers", () => {
  it("keep the first sign-in time and refresh the rest at each sign-in (FR-008, FR-012)", async () => {
    const profile = { developerId, provider: "slack" as const, issuer: "https://slack.com", subject: "U0123ABCD", displayName: "Maya", slackUserId: "U0123ABCD" };
    const first = await store.upsertDeveloper(profile);
    clock = T0 + 86_400_000;
    const second = await store.upsertDeveloper({ ...profile, displayName: "Maya Chen" });
    expect(second).toMatchObject({ firstSignInAt: first.firstSignInAt, lastSignInAt: new Date(clock).toISOString(), displayName: "Maya Chen", revoked: false });
  });

  it("drop a Slack link and email the provider no longer gives", async () => {
    await store.upsertDeveloper({ developerId, provider: "oidc", issuer: "https://idp.example.test", subject: "s1", displayName: "Maya", email: "maya@example.com", slackUserId: "U0123ABCD" });
    const next = await store.upsertDeveloper({ developerId, provider: "oidc", issuer: "https://idp.example.test", subject: "s1", displayName: "Maya" });
    expect(next.email).toBeUndefined();
    expect(next.slackUserId).toBeUndefined();
  });
});

describe("AgentX codes", () => {
  // F2 (rulings.md): codes are single-use, so a code already tried with a wrong verifier or a
  // wrong redirect is already burned. Each negative case below gets its own fresh code.
  it("are stored hashed, redeem once with the right verifier and redirect, and expire after 5 minutes", async () => {
    const code = await store.issueCode({ developerId, amr: "slack", slackUserId: "U0123ABCD", codeChallenge: challenge, redirectUri: redirect });
    expect(code).toMatch(/^agxc_/);
    expect(JSON.stringify([...db.items.values()])).not.toContain(code);
    expect(db.get(`CODE#${sha256Hex(code)}`, "META")).toBeDefined();

    const wrongVerifier = await store.issueCode({ developerId, amr: "slack", slackUserId: "U0123ABCD", codeChallenge: challenge, redirectUri: redirect });
    expect(await store.redeemCode({ code: wrongVerifier, verifier: "w".repeat(64), redirectUri: redirect })).toBeUndefined();

    const wrongRedirect = await store.issueCode({ developerId, amr: "slack", slackUserId: "U0123ABCD", codeChallenge: challenge, redirectUri: redirect });
    expect(await store.redeemCode({ code: wrongRedirect, verifier, redirectUri: "http://127.0.0.1:49153/callback" })).toBeUndefined();

    expect(await store.redeemCode({ code, verifier, redirectUri: redirect })).toEqual({ developerId, amr: "slack", slackUserId: "U0123ABCD" });
    expect(await store.redeemCode({ code, verifier, redirectUri: redirect })).toBeUndefined();

    const late = await store.issueCode({ developerId, amr: "oidc", codeChallenge: challenge, redirectUri: redirect });
    clock += 301_000;
    expect(await store.redeemCode({ code: late, verifier, redirectUri: redirect })).toBeUndefined();
  });

  it("burn a code even when the verifier is wrong, so it cannot be guessed at", async () => {
    const code = await store.issueCode({ developerId, amr: "slack", codeChallenge: challenge, redirectUri: redirect });
    await store.redeemCode({ code, verifier: "w".repeat(64), redirectUri: redirect });
    expect(await store.redeemCode({ code, verifier, redirectUri: redirect })).toBeUndefined();
  });
});

describe("sessions and refresh tokens (FR-005)", () => {
  it("store only the refresh token's hash and end 7 days after sign-in", async () => {
    const { session, refreshToken } = await store.createSession({ developerId, amr: "slack", slackUserId: "U0123ABCD" });
    expect(refreshToken).toMatch(/^agxr_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify([...db.items.values()])).not.toContain(refreshToken);
    expect(session.endsAt).toBe(T0 / 1000 + 604_800);
    expect(await store.lookupRefresh(refreshToken)).toMatchObject({ kind: "active", session: { sessionId: session.sessionId } });
  });

  it("rotate: the old token becomes reused, the new one active, and the end date stays put", async () => {
    const { refreshToken } = await store.createSession({ developerId, amr: "slack" });
    const lookup = await store.lookupRefresh(refreshToken);
    if (lookup.kind !== "active") throw new Error("expected active");
    clock = T0 + 3_600_000;
    const rotated = await store.rotateRefresh(lookup);
    if (!("refreshToken" in rotated)) throw new Error("expected a new token");
    expect(await store.lookupRefresh(refreshToken)).toEqual({ kind: "reused", sessionId: lookup.session.sessionId });
    const next = await store.lookupRefresh(rotated.refreshToken);
    expect(next).toMatchObject({ kind: "active", session: { endsAt: T0 / 1000 + 604_800 } });
  });

  it("answer reused when the same token rotates twice (a race)", async () => {
    const { refreshToken } = await store.createSession({ developerId, amr: "slack" });
    const lookup = await store.lookupRefresh(refreshToken);
    if (lookup.kind !== "active") throw new Error("expected active");
    await store.rotateRefresh(lookup);
    expect(await store.rotateRefresh(lookup)).toEqual({ reused: true });
  });

  it("report ended after revocation and after 7 days, and unknown for a token never issued", async () => {
    const one = await store.createSession({ developerId, amr: "slack" });
    await store.revokeSession(one.session.sessionId, "refresh_token_reused");
    expect(await store.lookupRefresh(one.refreshToken)).toMatchObject({ kind: "ended", session: { revokedReason: "refresh_token_reused" } });
    const two = await store.createSession({ developerId, amr: "oidc" });
    clock = T0 + 604_801_000;
    expect((await store.lookupRefresh(two.refreshToken)).kind).toBe("ended");
    expect(await store.lookupRefresh(`agxr_${"z".repeat(43)}`)).toEqual({ kind: "unknown" });
  });
});
