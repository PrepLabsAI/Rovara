// tests/contract/canary-session.test.ts
// CANARY-SESSION: the beta canary's session function. Real stores over the wire-level fake table, the real KMS signer over a fake KMS, the real token verifier and the real broker
// session check (authenticateDeveloper). A request can choose nothing; the session is a member's, one company, 30 minutes, with no refresh token anywhere an answer or a log can reach.
import { decodeJwt } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { DEVELOPER_TOKEN_AUDIENCE, DEVELOPER_ACCESS_TOKEN_SECONDS, AgentXError } from "@agentx/contracts";
import { authenticateDeveloper } from "../../packages/broker/src/aws/developer-routes.js";
import { handler as awsHandler } from "../../packages/broker/src/aws/canary-session.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { CANARY_MINTS_PER_HOUR, CANARY_SESSION_SECONDS, canarySessionConfigFromEnvironment, createCanarySession } from "../../packages/broker/src/developer/canary-session.js";
import { sessionLogId } from "../../packages/broker/src/developer/session-log-id.js";
import { GITHUB_ISSUER } from "../../packages/broker/src/developer/providers.js";
import { developerTokenVerifier } from "../../packages/broker/src/developer/verify-token.js";
import { CANARY, COMPANY, CONFIG, ENV, OTHER_COMPANY, OWNER, SECONDS, TABLE, world, type World } from "../support/canary-session-world.js";
import { ISSUER, T0 } from "../support/developer-fakes.js";

const sessionRows = (w: World) => [...w.db.items.values()].filter((row) => row.entityType === "SESSION");
const refreshRows = (w: World) => [...w.db.items.values()].filter((row) => row.entityType === "REFRESH_TOKEN");
type Minted = { ok: true; token: string; expiresAt: number; sessionId: string; memberCount: number };
const mintOk = async (w: World): Promise<Minted> => {
  const answer = await w.run({ kind: "canary-session" }) as Minted;
  expect(answer.ok).toBe(true);
  return answer;
};
const brokerStatus = async (w: World, token: string): Promise<number> => {
  try { await authenticateDeveloper(w.routes, decodeJwt(token)); return 200; } catch (error) { if (error instanceof AgentXError) return error.statusCode; throw error; }
};

describe("a minted session", () => {
  let w: World;
  beforeEach(async () => { w = await world(); });

  it("answers exactly the contract Cloud calls, with a token the broker's own verifier accepts for the canary person", async () => {
    const answer = await mintOk(w);
    expect(Object.keys(answer).sort()).toEqual(["expiresAt", "memberCount", "ok", "sessionId", "token"]);
    expect(answer.memberCount).toBe(1);
    expect(answer.expiresAt).toBe((SECONDS(T0) + CANARY_SESSION_SECONDS) * 1000);
    const verify = developerTokenVerifier({ issuer: ISSUER, keys: async () => (await w.signer.jwks()).keys, now: () => w.clock.now });
    const claims = await verify(`Bearer ${answer.token}`);
    expect(claims).toMatchObject({ iss: ISSUER, aud: DEVELOPER_TOKEN_AUDIENCE, sub: CANARY, amr: "github", env: ENV, sid: answer.sessionId });
    expect(claims.exp! - claims.iat!).toBe(DEVELOPER_ACCESS_TOKEN_SECONDS);
    expect(claims).not.toHaveProperty("azp");
    expect(claims).not.toHaveProperty("scope");
  });

  it("writes the session row a GitHub sign-in writes: this person, this company, the shared method, thirty minutes, no client, no scopes, never an administrator", async () => {
    const answer = await mintOk(w);
    const [row] = sessionRows(w);
    expect(sessionRows(w)).toHaveLength(1);
    expect(row).toMatchObject({ pk: `SESSION#${answer.sessionId}`, developerId: CANARY, amr: "github", companyId: COMPANY, installMethod: true, endsAt: SECONDS(T0) + CANARY_SESSION_SECONDS });
    for (const absent of ["clientId", "scopes", "administrator", "signedInId", "joinedByInvite", "slackUserId", "revokedAt"]) expect(row, absent).not.toHaveProperty(absent);
  });

  it("is a session the real broker check accepts for thirty minutes and refuses after: the token's own hour does not extend it", async () => {
    const answer = await mintOk(w);
    expect(await brokerStatus(w, answer.token)).toBe(200);
    w.clock.now = T0 + (CANARY_SESSION_SECONDS - 1) * 1000;
    expect(await brokerStatus(w, answer.token)).toBe(200);
    w.clock.now = T0 + CANARY_SESSION_SECONDS * 1000 + 1000;
    expect(decodeJwt(answer.token).exp!).toBeGreaterThan(SECONDS(w.clock.now));
    expect(await brokerStatus(w, answer.token)).toBe(401);
  });

  it("never returns or logs a refresh token or the access token (the refresh row is stored hashed, its secret is dropped unread)", async () => {
    const answer = await mintOk(w);
    expect(refreshRows(w)).toHaveLength(1);
    const everything = JSON.stringify([answer, w.logs]);
    expect(everything).not.toContain("agxr_");
    expect(JSON.stringify(w.logs)).not.toContain(answer.token);
    expect(JSON.stringify(w.logs)).not.toContain(answer.token.split(".")[1]!);
    // The line carries a short hash of the session id under `session`, never the id itself.
    expect(w.logs).toEqual([{ event: "signin.canary_session", session: sessionLogId(answer.sessionId), developerId: CANARY }]);
    expect(JSON.stringify(w.logs)).not.toContain(answer.sessionId);
    // The refresh row holds only a hash of a secret nobody holds: no stored field is a usable token.
    expect(JSON.stringify([...w.db.items.values()])).not.toContain("agxr_");
  });

  it("starts nothing else: one session row, one refresh row, one counter item, and no DEVELOPER, company or membership row changed", async () => {
    const before = new Map([...w.db.items.values()].map((row) => [`${String(row.pk)}|${String(row.sk)}`, JSON.stringify(row)]));
    await mintOk(w);
    const after = new Map([...w.db.items.values()].map((row) => [`${String(row.pk)}|${String(row.sk)}`, JSON.stringify(row)]));
    const added = [...after.keys()].filter((key) => !before.has(key)).map((key) => key.split("#")[0]).sort();
    expect(added).toEqual(["CANARY_MINT", "REFRESH", "SESSION"]);
    for (const [key, text] of before) expect(after.get(key)).toBe(text);
  });
});

describe("a request can choose nothing", () => {
  let w: World;
  beforeEach(async () => { w = await world(); });
  const bad: Array<[string, unknown]> = [
    ["a subject", { kind: "canary-session", subject: OWNER }], ["a developer id", { kind: "canary-session", developerId: OWNER }], ["a company id", { kind: "canary-session", companyId: OTHER_COMPANY }],
    ["an amr", { kind: "canary-session", amr: "oidc" }], ["a lifetime", { kind: "canary-session", endsAt: 9_999_999_999 }], ["an administrator flag", { kind: "canary-session", administrator: true }],
    ["scopes", { kind: "canary-session", scopes: ["admin"] }], ["a client", { kind: "canary-session", clientId: "x" }], ["an extra field on end", { kind: "canary-end", all: true }],
    ["another kind", { kind: "company-member-role-set" }], ["no kind", {}], ["a wrong-case kind", { kind: "Canary-Session" }], ["an array", [{ kind: "canary-session" }]],
    ["a string", "canary-session"], ["null", null], ["undefined", undefined], ["a number", 7], ["an http event", { version: "2.0", rawPath: "/v1/auth/token", requestContext: {}, body: "{}" }],
    ["a huge body", { kind: "canary-session", padding: "x".repeat(2_000_000) }], ["a prototype key", JSON.parse('{"kind":"canary-session","__proto__":{"subject":"x"}}')],
  ];
  it.each(bad)("refuses %s and writes nothing", async (_name, event) => {
    const before = w.db.items.size;
    expect(await w.run(event)).toEqual({ ok: false, error: "refused" });
    expect(w.db.items.size).toBe(before);
    expect(w.logs.at(-1)).toEqual({ event: "signin.canary_refused", code: "refused" });
  });
});

describe("refusals (each one fails closed with the fixed word, no token, nothing started)", () => {
  const refused = async (w: World) => {
    const before = sessionRows(w).length;
    const answer = await w.run({ kind: "canary-session" });
    expect(answer).toEqual({ ok: false, error: "refused" });
    expect(sessionRows(w)).toHaveLength(before);
    expect(JSON.stringify(w.logs)).not.toMatch(/eyJ|agxr_/);
  };
  const row = (w: World, pk: string) => w.db.get(pk, "META");

  it("the person's row is missing", async () => { const w = await world(); w.db.delete(`DEVELOPER#${CANARY}`, "META"); await refused(w); });
  it("the person is revoked", async () => { const w = await world(); w.db.set({ ...row(w, `DEVELOPER#${CANARY}`)!, revoked: true }); await refused(w); });
  it("the person is not a GitHub sign-in", async () => { const w = await world(); w.db.set({ ...row(w, `DEVELOPER#${CANARY}`)!, provider: "slack" }); await refused(w); });
  it("the person's identity was merged into another", async () => { const w = await world(); w.db.set({ ...row(w, `DEVELOPER#${CANARY}`)!, mergedInto: OWNER }); await refused(w); });
  it("the person's sign-in was unlinked", async () => { const w = await world(); w.db.set({ ...row(w, `DEVELOPER#${CANARY}`)!, unlinkedAt: new Date(T0).toISOString() }); await refused(w); });
  it("the person has no membership", async () => { const w = await world(); w.db.delete(`COMPANY_MEMBER#${CANARY}`, "COMPANY"); await refused(w); });
  it("the person's membership is in another company", async () => {
    const w = await world(); w.db.set({ ...w.db.get(`COMPANY_MEMBER#${CANARY}`, "COMPANY")!, companyId: OTHER_COMPANY }); await refused(w);
  });
  it("the person's membership is revoked", async () => {
    const w = await world(); w.db.set({ ...w.db.get(`COMPANY_MEMBER#${CANARY}`, "COMPANY")!, revokedAt: new Date(T0).toISOString() }); await refused(w);
  });
  it("the person is an admin, not a member", async () => {
    const w = await world(); w.db.set({ ...w.db.get(`COMPANY_MEMBER#${CANARY}`, "COMPANY")!, role: "admin" }); await refused(w);
  });
  it("the company has a second plain member (member count 2)", async () => {
    const w = await world(); await w.company.preapprove(COMPANY, "second@example.test", "member", 24);
    const second = ownerKeyForSubject(GITHUB_ISSUER, "second");
    expect((await w.company.join({ personId: second, companyId: COMPANY, email: "second@example.test" })).ok).toBe(true);
    await refused(w);
  });
  it("the company has no plain member but a different one (the roster does not name the canary person)", async () => {
    const w = await world();
    const mirror = w.db.find((r) => r.entityType === "COMPANY_MEMBER_VIEW" && r.personId === CANARY)[0]!;
    w.db.set({ ...mirror, role: "admin" });
    await refused(w);
  });
  it("the company has more members than one page reads (the page shows exactly the canary person, and still more follow)", async () => {
    const w = await world(); w.deps.company = { companyExists: (c: string) => w.company.companyExists(c), hasOwnIssuer: (c: string) => w.company.hasOwnIssuer(c), membership: (p: string) => w.company.membership(p), listMembers: async (company: string, cursor?: string, limit?: number) => ({ ...(await w.company.listMembers(company, cursor, limit)), more: true }) };
    await refused({ ...w, run: createCanarySession(w.deps) });
  });
  it("the company has a sign-in of its own (GitHub is only the shared method)", async () => {
    const w = await world(); w.db.set({ pk: `ORG#${COMPANY}#SIGNIN_ISSUER`, sk: "OIDC", entityType: "COMPANY_SIGNIN_ISSUER" }); await refused(w);
  });
  it("the company record is gone", async () => { const w = await world(); w.db.delete(`ORG#${COMPANY}#COMPANY`, "META"); await refused(w); });
  it("the store cannot be read (any exception)", async () => {
    const w = await world(); w.deps.store = { ...w.store, getDeveloper: async () => { throw new Error("boom with a secret value"); }, createSession: w.store.createSession.bind(w.store), revokeSession: w.store.revokeSession.bind(w.store) };
    await refused({ ...w, run: createCanarySession(w.deps) });
    expect(JSON.stringify(w.logs)).not.toContain("secret value");
  });

  it("the 21st mint in one hour is refused (and a new hour starts a new count)", async () => {
    const w = await world();
    for (let i = 0; i < CANARY_MINTS_PER_HOUR; i++) await mintOk(w);
    await refused(w);
    expect(w.logs.at(-1)).toEqual({ event: "signin.canary_refused", code: "rate" });
    w.clock.now += 60 * 60 * 1000;
    await mintOk(w);
  });

  it("the token cannot be issued: the session row written is revoked before answering, and no token leaves", async () => {
    const w = await world(); w.deps.signer = { publicJwk: () => w.signer.publicJwk(), sign: async () => { throw new Error("kms down"); } };
    expect(await createCanarySession(w.deps)({ kind: "canary-session" })).toEqual({ ok: false, error: "refused" });
    const [row] = sessionRows(w);
    expect(sessionRows(w)).toHaveLength(1);
    expect(row!.revokedAt).toBeDefined();
    expect(row!.revokedReason).toBe("canary-end");
  });

  it("the session cannot be recorded for canary-end: the row is revoked before answering", async () => {
    const w = await world(); w.deps.counter = { reserve: w.counter.reserve.bind(w.counter), record: async () => { throw new Error("full"); }, recorded: w.counter.recorded.bind(w.counter), clear: w.counter.clear.bind(w.counter) };
    expect(await createCanarySession(w.deps)({ kind: "canary-session" })).toEqual({ ok: false, error: "refused" });
    expect(sessionRows(w)).toHaveLength(1);
    expect(sessionRows(w)[0]!.revokedAt).toBeDefined();
  });

  it("an unreadable counter item is refused, never a silent fallback", async () => {
    const w = await world(); await mintOk(w);
    const item = w.db.find((r) => r.entityType === "CANARY_MINT")[0]!;
    w.db.set({ ...item, sessionIds: "not-a-list" });
    expect(await w.run({ kind: "canary-end" })).toEqual({ ok: false, error: "refused" });
  });

  it("reads a counter item tolerantly: unknown fields from a later version are ignored", async () => {
    const w = await world(); const answer = await mintOk(w);
    const item = w.db.find((r) => r.entityType === "CANARY_MINT")[0]!;
    w.db.set({ ...item, addedLater: { anything: true } });
    expect(await w.run({ kind: "canary-end" })).toEqual({ ok: true });
    expect(w.db.get(`SESSION#${answer.sessionId}`, "META")!.revokedAt).toBeDefined();
  });
});

describe("not set up", () => {
  it("answers not_set_up for every request and writes nothing when the function has no configuration", async () => {
    const w = await world({ config: undefined, seed: false });
    for (const event of [{ kind: "canary-session" }, { kind: "canary-end" }, { junk: true }, undefined]) expect(await w.run(event)).toEqual({ ok: false, error: "not_set_up" });
    expect(w.db.items.size).toBe(0);
  });

  const good = { CANARY_ENVIRONMENT: "beta", CANARY_DEVELOPER_ID: CANARY, CANARY_COMPANY_ID: COMPANY, CANARY_ISSUER: ISSUER, DEVELOPER_TOKEN_ISSUER: ISSUER, AGENTX_ENV: ENV };
  it("reads the settings from the environment only when all of them are right", () => {
    expect(canarySessionConfigFromEnvironment(good)).toEqual(CONFIG);
  });
  const broken: Array<[string, Record<string, string | undefined>]> = [
    ["a stage word instead of beta", { CANARY_ENVIRONMENT: "staging" }], ["production", { CANARY_ENVIRONMENT: "production" }], ["a different case", { CANARY_ENVIRONMENT: "Beta" }],
    ["no environment", { CANARY_ENVIRONMENT: undefined }], ["an issuer that is not the one signed for", { CANARY_ISSUER: `${ISSUER}x` }], ["no pinned issuer", { CANARY_ISSUER: undefined }],
    ["no token issuer", { DEVELOPER_TOKEN_ISSUER: undefined, CANARY_ISSUER: undefined }], ["no AGENTX_ENV", { AGENTX_ENV: undefined }],
    ["a person that is not 64 hex", { CANARY_DEVELOPER_ID: "canary-bot" }], ["no person", { CANARY_DEVELOPER_ID: undefined }], ["a company that is not an org id", { CANARY_COMPANY_ID: "company" }],
    ["no company", { CANARY_COMPANY_ID: undefined }], ["the built-in company", { CANARY_COMPANY_ID: "org_000000000000000000000" }],
  ];
  it.each(broken)("is not set up with %s", (_name, override) => {
    expect(canarySessionConfigFromEnvironment({ ...good, ...override })).toBeUndefined();
  });

  it("the Lambda entry answers not_set_up outside beta and refused when it cannot be built, never an error", async () => {
    const saved = { ...process.env };
    try {
      for (const key of Object.keys(process.env)) if (key.startsWith("CANARY_")) delete process.env[key];
      Object.assign(process.env, { AWS_REGION: "us-east-1", DEVELOPER_TOKEN_ISSUER: ISSUER, AGENTX_ENV: ENV, DEVELOPER_SIGNIN_TABLE_NAME: TABLE, DEVELOPER_TOKEN_KEY_ARN: "arn:aws:kms:us-east-1:111122223333:key/test-key" });
      expect(await awsHandler({ kind: "canary-session" })).toEqual({ ok: false, error: "not_set_up" });
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});

describe("canary-end", () => {
  it("revokes exactly the sessions this function started, is idempotent, and touches no other session of the person", async () => {
    const w = await world();
    const first = await mintOk(w);
    const second = await mintOk(w);
    const ordinary = (await w.store.createSession({ developerId: CANARY, amr: "github", companyId: COMPANY, installMethod: true })).session;
    expect(await brokerStatus(w, first.token)).toBe(200);
    expect(await w.run({ kind: "canary-end" })).toEqual({ ok: true });
    expect(await brokerStatus(w, first.token)).toBe(401);
    expect(await brokerStatus(w, second.token)).toBe(401);
    expect(w.db.get(`SESSION#${first.sessionId}`, "META")).toMatchObject({ revokedReason: "canary-end" });
    expect(w.db.get(`SESSION#${ordinary.sessionId}`, "META")!.revokedAt).toBeUndefined();
    const after = JSON.stringify([...w.db.items.values()]);
    expect(await w.run({ kind: "canary-end" })).toEqual({ ok: true });
    expect(JSON.stringify([...w.db.items.values()])).toBe(after);
  });

  it("keeps a session recorded while the list was being revoked: the clear is conditional on the list it revoked, and the pass runs again", async () => {
    const w = await world();
    const first = await mintOk(w);
    let injected: string | undefined;
    const real = w.counter;
    w.deps.counter = {
      reserve: real.reserve.bind(real), record: real.record.bind(real), recorded: real.recorded.bind(real),
      clear: async (key, seen) => {
        if (injected === undefined) {
          // A mint lands between the read and the clear (another lane run): its record is written into the same item.
          const second = await mintOk(w);
          injected = second.sessionId;
        }
        return real.clear(key, seen);
      },
    };
    expect(await createCanarySession(w.deps)({ kind: "canary-end" })).toEqual({ ok: true });
    expect(w.db.get(`SESSION#${first.sessionId}`, "META")!.revokedAt).toBeDefined();
    expect(w.db.get(`SESSION#${injected!}`, "META")!.revokedAt).toBeDefined();
  });

  it("refuses (and leaves the 30-minute end to stand) when the list keeps changing under it", async () => {
    const w = await world();
    await mintOk(w);
    const real = w.counter;
    w.deps.counter = { reserve: real.reserve.bind(real), record: real.record.bind(real), recorded: real.recorded.bind(real), clear: async () => false };
    expect(await createCanarySession(w.deps)({ kind: "canary-end" })).toEqual({ ok: false, error: "refused" });
  });

  it("answers ok when nothing was started, and finds a session started in the hour before", async () => {
    const w = await world();
    expect(await w.run({ kind: "canary-end" })).toEqual({ ok: true });
    w.clock.now = Date.parse("2026-09-27T12:59:30.000Z");
    const late = await mintOk(w);
    w.clock.now = Date.parse("2026-09-27T13:05:00.000Z");
    expect(await w.run({ kind: "canary-end" })).toEqual({ ok: true });
    expect(w.db.get(`SESSION#${late.sessionId}`, "META")!.revokedAt).toBeDefined();
  });

  it("returns no token and logs no id of anyone else", async () => {
    const w = await world(); await mintOk(w);
    w.logs.length = 0;
    expect(await w.run({ kind: "canary-end" })).toEqual({ ok: true });
    expect(w.logs).toEqual([{ event: "signin.canary_end" }]);
  });
});
