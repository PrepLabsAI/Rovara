// tests/contract/developer-signin-store.test.ts
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { DeveloperSignInStore, REFRESH_REUSE_GRACE_SECONDS } from "../../packages/broker/src/developer/store.js";
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

/**
 * Fix round 1, F1: real DynamoDB always reports a cancelled TransactWriteItems with a
 * CancellationReasons array, one entry per TransactItem, "None" for items not implicated
 * (docs.aws.amazon.com/amazondynamodb .../TransactionCanceledException). FakeDynamoDb does not
 * track per-item reasons, so this wraps it to manufacture that shape for one TransactWriteCommand,
 * then falls through to the real fake for everything else (including the rest of that same
 * transaction's item checks, since the manufactured throw happens before any real send).
 */
function withTransactConflict(real: FakeDynamoDb, reasons: Array<{ Code: string }>): { send(command: unknown): Promise<unknown> } {
  let armed = true;
  return {
    async send(command: unknown) {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (armed && name === "TransactWriteCommand") {
        armed = false;
        throw Object.assign(new Error("simulated transaction cancellation"), {
          name: "TransactionCanceledException",
          CancellationReasons: reasons,
        });
      }
      return real.send(command as Parameters<typeof real.send>[0]);
    },
  };
}

/**
 * Fix round 1, F3: simulates a concurrent revocation landing between upsertDeveloper's internal
 * read and its internal write, by injecting the mutation immediately before the first write this
 * store issues for the given key (whichever DynamoDB verb that is), then delegating for real. A
 * blind read-then-overwrite clobbers the injected revocation; an atomic conditional update does not.
 */
function withConcurrentRevocation(real: FakeDynamoDb, key: string): { send(command: unknown): Promise<unknown> } {
  let armed = true;
  return {
    async send(command: unknown) {
      const name = (command as { constructor: { name: string } }).constructor.name;
      const input = (command as { input: { Key?: { pk: string }; Item?: { pk: string } } }).input;
      const targetsKey = input.Key?.pk === key || input.Item?.pk === key;
      if (armed && targetsKey && (name === "PutCommand" || name === "UpdateCommand")) {
        armed = false;
        const current = real.get(key, "META");
        if (current !== undefined) real.set({ ...current, revoked: true });
      }
      return real.send(command as Parameters<typeof real.send>[0]);
    },
  };
}

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

  // Fix round 1, F3: upsertDeveloper must not overwrite a concurrent revocation.
  it("never lets a re-sign-in un-revoke a developer racing a concurrent revocation", async () => {
    const profile = { developerId, provider: "slack" as const, issuer: "https://slack.com", subject: "U0123ABCD", displayName: "Maya", slackUserId: "U0123ABCD" };
    await store.upsertDeveloper(profile);

    const racingStore = new DeveloperSignInStore({
      documentClient: withConcurrentRevocation(db, `DEVELOPER#${developerId}`),
      tableName: "signin",
      now: () => clock,
    });
    clock = T0 + 60_000;
    const next = await racingStore.upsertDeveloper({ ...profile, displayName: "Maya Chen" });
    expect(next).toMatchObject({ revoked: true, displayName: "Maya Chen" });
    expect(db.get(`DEVELOPER#${developerId}`, "META")).toMatchObject({ revoked: true });
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
    clock += 61_000; // past the reuse grace window (fix round 1, F2); see "refresh reuse grace window" below
    expect(await store.lookupRefresh(refreshToken)).toEqual({ kind: "reused", sessionId: lookup.session.sessionId });
    const next = await store.lookupRefresh(rotated.refreshToken);
    expect(next).toMatchObject({ kind: "active", session: { endsAt: T0 / 1000 + 604_800 } });
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

// Fix round 1, F1: a cancelled transaction must be read for which item's condition actually
// failed, not blanket-reported as reuse (DynamoDB also cancels for TransactionConflict and
// throttling, and Task 6 revokes the session on "reused").
describe("rotation failures distinguish reuse, ended and transient errors", () => {
  it("reports reused precisely when CancellationReasons names the old token's condition", async () => {
    const { refreshToken } = await store.createSession({ developerId, amr: "slack" });
    const lookup = await store.lookupRefresh(refreshToken);
    if (lookup.kind !== "active") throw new Error("expected active");
    const reusedStore = new DeveloperSignInStore({
      documentClient: withTransactConflict(db, [{ Code: "ConditionalCheckFailed" }, { Code: "None" }, { Code: "None" }]),
      tableName: "signin",
      now: () => clock,
    });
    expect(await reusedStore.rotateRefresh(lookup)).toEqual({ reused: true });
  });

  it("reports ended precisely when CancellationReasons names the session's condition", async () => {
    const { refreshToken } = await store.createSession({ developerId, amr: "slack" });
    const lookup = await store.lookupRefresh(refreshToken);
    if (lookup.kind !== "active") throw new Error("expected active");
    const endedStore = new DeveloperSignInStore({
      documentClient: withTransactConflict(db, [{ Code: "None" }, { Code: "None" }, { Code: "ConditionalCheckFailed" }]),
      tableName: "signin",
      now: () => clock,
    });
    expect(await endedStore.rotateRefresh(lookup)).toEqual({ ended: true });
  });

  it("rethrows a transaction conflict instead of reporting reuse, and leaves the token active", async () => {
    const { refreshToken } = await store.createSession({ developerId, amr: "slack" });
    const lookup = await store.lookupRefresh(refreshToken);
    if (lookup.kind !== "active") throw new Error("expected active");
    const conflictStore = new DeveloperSignInStore({
      documentClient: withTransactConflict(db, [{ Code: "None" }, { Code: "TransactionConflict" }, { Code: "None" }]),
      tableName: "signin",
      now: () => clock,
    });
    await expect(conflictStore.rotateRefresh(lookup)).rejects.toThrow("simulated transaction cancellation");
    expect(await store.lookupRefresh(refreshToken)).toMatchObject({ kind: "active" });
  });

  // Fix round 1, F4: the session condition now also requires endsAt > :now.
  it("rotateRefresh refuses once the session's end date has passed, even given a lookup taken before", async () => {
    const { refreshToken } = await store.createSession({ developerId, amr: "slack" });
    const lookup = await store.lookupRefresh(refreshToken);
    if (lookup.kind !== "active") throw new Error("expected active");
    clock = T0 + 604_801_000;
    expect(await store.rotateRefresh(lookup)).toEqual({ ended: true });
  });
});

// Fix round 1, F2 (owner ruling): an Auth0-style reuse interval. A token presented again within
// REFRESH_REUSE_GRACE_SECONDS of its own rotation is not treated as theft, so a lost response or a
// stale-lock race between two local processes does not sign the person out.
describe("refresh reuse grace window", () => {
  it("inside the window, presenting the just-rotated token again mints a fresh successor without revoking the session", async () => {
    const { session, refreshToken } = await store.createSession({ developerId, amr: "slack" });
    const lookup = await store.lookupRefresh(refreshToken);
    if (lookup.kind !== "active") throw new Error("expected active");
    const rotated = await store.rotateRefresh(lookup);
    if (!("refreshToken" in rotated)) throw new Error("expected a new token");

    clock += 59_000;
    const replay = await store.lookupRefresh(refreshToken);
    expect(replay).toMatchObject({ kind: "recently_rotated", session: { sessionId: session.sessionId } });
    if (replay.kind !== "recently_rotated") throw new Error("expected recently_rotated");

    const successor = await store.rotateRecentlyUsed(replay);
    if (!("refreshToken" in successor)) throw new Error("expected a successor token");
    expect(successor.refreshToken).toMatch(/^agxr_[A-Za-z0-9_-]{43}$/);

    const finalSession = await store.getSession(session.sessionId);
    expect(finalSession?.revokedAt).toBeUndefined();
    expect(await store.lookupRefresh(rotated.refreshToken)).toMatchObject({ kind: "active" });
    expect(await store.lookupRefresh(successor.refreshToken)).toMatchObject({ kind: "active" });
  });

  it("outside the window, presenting the same token again is reused as before", async () => {
    const { refreshToken } = await store.createSession({ developerId, amr: "slack" });
    const lookup = await store.lookupRefresh(refreshToken);
    if (lookup.kind !== "active") throw new Error("expected active");
    await store.rotateRefresh(lookup);

    clock += 61_000;
    expect(await store.lookupRefresh(refreshToken)).toEqual({ kind: "reused", sessionId: lookup.session.sessionId });
  });

  it("a revoked session never rotates, even inside the grace window", async () => {
    const { session, refreshToken } = await store.createSession({ developerId, amr: "slack" });
    const lookup = await store.lookupRefresh(refreshToken);
    if (lookup.kind !== "active") throw new Error("expected active");
    const rotated = await store.rotateRefresh(lookup);
    if (!("refreshToken" in rotated)) throw new Error("expected a new token");
    await store.revokeSession(session.sessionId, "refresh_token_reused");

    clock += 1_000;
    expect(await store.lookupRefresh(refreshToken)).toEqual({ kind: "reused", sessionId: session.sessionId });
    expect(await store.rotateRecentlyUsed({ session: lookup.session, tokenHash: lookup.tokenHash })).toEqual({ reused: true });
  });

  // Fix round 2, F5: the window comparison must be strict (usedAt > now - window) in both
  // lookupRefresh and the mint condition, so the boundary itself (exactly 60s elapsed) is outside.
  it("treats exactly 60 seconds elapsed as outside the grace window (strict comparison)", async () => {
    const { refreshToken } = await store.createSession({ developerId, amr: "slack" });
    const lookup = await store.lookupRefresh(refreshToken);
    if (lookup.kind !== "active") throw new Error("expected active");
    await store.rotateRefresh(lookup);

    clock += REFRESH_REUSE_GRACE_SECONDS * 1000; // exactly at the boundary, not inside it
    expect(await store.lookupRefresh(refreshToken)).toEqual({ kind: "reused", sessionId: lookup.session.sessionId });
  });
});

// Fix round 2, F2 and F3: the real two-process race, handled inside the store so Task 6 needs no
// change. When rotateRefresh's old-token condition fails, the store itself checks whether that
// token was used within the grace window and, if so, mints a successor internally (one grace mint
// per old token, capped so a third presentation is reused).
describe("rotateRefresh's internal grace mint (the real two-process race)", () => {
  it("two concurrent rotateRefresh calls on one token both get a live successor, and the session is not revoked", async () => {
    const { session, refreshToken } = await store.createSession({ developerId, amr: "slack" });
    const lookup = await store.lookupRefresh(refreshToken);
    if (lookup.kind !== "active") throw new Error("expected active");

    const winner = await store.rotateRefresh(lookup);
    if (!("refreshToken" in winner)) throw new Error("expected the winner to get a token");
    const loser = await store.rotateRefresh(lookup); // same stale lookup, presented again immediately
    if (!("refreshToken" in loser)) throw new Error("expected the loser to also get a token via an internal grace mint");

    expect(winner.refreshToken).not.toBe(loser.refreshToken);
    expect(await store.lookupRefresh(winner.refreshToken)).toMatchObject({ kind: "active" });
    expect(await store.lookupRefresh(loser.refreshToken)).toMatchObject({ kind: "active" });
    const finalSession = await store.getSession(session.sessionId);
    expect(finalSession?.revokedAt).toBeUndefined();
  });

  it("outside the grace window, a second rotateRefresh on the same token is reused, not a grace mint", async () => {
    const { refreshToken } = await store.createSession({ developerId, amr: "slack" });
    const lookup = await store.lookupRefresh(refreshToken);
    if (lookup.kind !== "active") throw new Error("expected active");
    await store.rotateRefresh(lookup);

    clock += 61_000;
    expect(await store.rotateRefresh(lookup)).toEqual({ reused: true });
  });

  // Fix round 2, F3 (security ruling): one grace mint per old token caps it at two lineages. The
  // first successor stays valid (invalidating it would break the two-process case above), but a
  // third presentation of the original old token finds the grace mint already spent.
  it("caps the grace mint at one per old token: a third presentation is reused", async () => {
    const { refreshToken } = await store.createSession({ developerId, amr: "slack" });
    const lookup = await store.lookupRefresh(refreshToken);
    if (lookup.kind !== "active") throw new Error("expected active");

    const first = await store.rotateRefresh(lookup); // the real rotation
    if (!("refreshToken" in first)) throw new Error("expected the first rotation to succeed");
    const second = await store.rotateRefresh(lookup); // the one allowed grace mint
    if (!("refreshToken" in second)) throw new Error("expected the grace mint to succeed");
    const third = await store.rotateRefresh(lookup); // no grace mints left

    expect(third).toEqual({ reused: true });
    // The first successor is untouched by the third (failed) presentation.
    expect(await store.lookupRefresh(first.refreshToken)).toMatchObject({ kind: "active" });
    expect(await store.lookupRefresh(second.refreshToken)).toMatchObject({ kind: "active" });
  });
});

// Fix round 2, F1: rotateRecentlyUsed must classify a cancelled transaction the same way
// classifyRotationFailure does, not blanket-treat any condition failure as reused (that would let a
// transient conflict or a throttle on the grace path get revoked as if it were theft).
describe("rotateRecentlyUsed classifies failures precisely", () => {
  it("rethrows a transient conflict on the old-token check instead of reporting reuse", async () => {
    const { refreshToken } = await store.createSession({ developerId, amr: "slack" });
    const lookup = await store.lookupRefresh(refreshToken);
    if (lookup.kind !== "active") throw new Error("expected active");
    await store.rotateRefresh(lookup);
    const replay = await store.lookupRefresh(refreshToken);
    if (replay.kind !== "recently_rotated") throw new Error("expected recently_rotated");

    const conflictStore = new DeveloperSignInStore({
      documentClient: withTransactConflict(db, [{ Code: "TransactionConflict" }, { Code: "None" }, { Code: "None" }]),
      tableName: "signin",
      now: () => clock,
    });
    await expect(conflictStore.rotateRecentlyUsed(replay)).rejects.toThrow("simulated transaction cancellation");
  });

  it("folds a dead session's condition failure into reused, since its signature has no ended kind", async () => {
    const { refreshToken } = await store.createSession({ developerId, amr: "slack" });
    const lookup = await store.lookupRefresh(refreshToken);
    if (lookup.kind !== "active") throw new Error("expected active");
    await store.rotateRefresh(lookup);
    const replay = await store.lookupRefresh(refreshToken);
    if (replay.kind !== "recently_rotated") throw new Error("expected recently_rotated");

    const endedStore = new DeveloperSignInStore({
      documentClient: withTransactConflict(db, [{ Code: "None" }, { Code: "None" }, { Code: "ConditionalCheckFailed" }]),
      tableName: "signin",
      now: () => clock,
    });
    expect(await endedStore.rotateRecentlyUsed(replay)).toEqual({ reused: true });
  });
});
