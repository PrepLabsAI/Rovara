// Lanes AU and EV: the company reads on the developer API. A sign-in client's token reaches them through the same checks as the other
// /v1/dev/client routes (a live session, the registration's audience), and then the read is the company administrator's, for their company only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeveloperApiConfiguration } from "../../packages/broker/src/aws/developer-routes.js";
import { developerTokenVerifier } from "../../packages/broker/src/developer/verify-token.js";
import { createAdminBroker, type AdminHandler } from "../support/admin-broker.js";
import { localSigner } from "../support/developer-fakes.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { COMPANY_A, COMPANY_B, IMPLICIT_COMPANY_ID, TASK_IN_SHARD, newStore, seedAudit, seedEvent } from "../support/company-reads-fixtures.js";

const ISSUER = "https://abc123.execute-api.us-east-1.amazonaws.com/v1/auth";
const T0 = Date.parse("2026-11-13T12:00:00.000Z");
const ADA = "a".repeat(64);
const BO = "b".repeat(64);
const CY = "c".repeat(64);
const signer = localSigner();
let db: FakeDynamoDb;
let handler: AdminHandler;
const store = newStore();

async function token(claims: Record<string, unknown> = {}): Promise<string> {
  const body = { iss: ISSUER, aud: "web-app", azp: "web-app", sub: ADA, amr: "oidc", env: "production", sid: "s-ada", iat: T0 / 1000, nbf: T0 / 1000, exp: T0 / 1000 + 3600, ...claims };
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: (await signer.publicJwk()).kid })).toString("base64url");
  const input = `${header}.${Buffer.from(JSON.stringify(body)).toString("base64url")}`;
  return `Bearer ${input}.${(await signer.sign(Buffer.from(input))).toString("base64url")}`;
}
async function call(method: string, path: string, authorization: string, query = "") {
  const response = await handler({ rawPath: path, rawQueryString: query, routeKey: "ANY /v1/dev/{proxy+}", headers: { authorization }, requestContext: { requestId: "r", http: { method } } });
  return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
}
function session(id: string, developerId: string, extra: Record<string, unknown> = {}) {
  db.set({ pk: `SESSION#${id}`, sk: "META", sessionId: id, developerId, amr: "oidc", clientId: "web-app", startedAt: new Date(T0).toISOString(), endsAt: T0 / 1000 + 604_800, ...extra });
}
const companyOf = async (developerId: string) => (developerId === ADA ? COMPANY_A : developerId === BO ? COMPANY_B : undefined);

async function broker(options: { clientRoutes?: true; companyReads?: unknown } = { clientRoutes: true, companyReads: { store, companyOf } }) {
  const linking: DeveloperApiConfiguration = {
    issuer: ISSUER, env: "production", methods: { slack: false, oidc: true }, signInTableName: "signin", channelMembers: vi.fn(), ...(options.clientRoutes === true ? { clientRoutes: true as const } : {}),
    verifyAccessToken: developerTokenVerifier({ issuer: ISSUER, keys: async () => [await signer.publicJwk()], now: () => Date.now() }),
  };
  ({ db, handler } = await createAdminBroker({ linking, channelAdapters: true, ...(options.companyReads === undefined ? {} : { companyReads: options.companyReads }) }));
  const at = new Date(T0 - 60_000).toISOString();
  db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://cloud.example.com/callback"], loopback: false, fullAccess: true, createdAt: at, updatedAt: at, updatedBy: "admin" });
  for (const [id, name] of [[ADA, "Ada"], [BO, "Bo"], [CY, "Cy"]] as const) db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, provider: "oidc", issuer: "https://idp.example.test", subject: name.toLowerCase(), displayName: name, email: `${name.toLowerCase()}@example.com`, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  session("s-ada", ADA, { administrator: true });
  session("s-bo", BO, { administrator: true });
  session("s-cy", CY);
}

beforeEach(async () => {
  vi.useFakeTimers({ now: T0, toFake: ["Date"] });
  for (let index = 0; index < 2; index += 1) {
    await seedAudit(store, COMPANY_A, { eventId: `evt_a${String(index)}`, at: `2026-11-10T10:0${String(index)}:00.000Z`, actor: { type: "person", id: ADA } });
    await seedAudit(store, COMPANY_B, { eventId: `evt_b${String(index)}`, at: `2026-11-10T10:0${String(index)}:00.000Z`, actor: { type: "person", id: BO } });
  }
  await seedEvent(store, COMPANY_A, { at: "2026-11-10T10:00:00.000Z", taskId: TASK_IN_SHARD(2) });
  await seedEvent(store, COMPANY_B, { at: "2026-11-10T10:00:00.000Z", taskId: TASK_IN_SHARD(2) });
  await broker();
});
afterEach(() => { vi.useRealTimers(); });

const AUDIT = "/v1/dev/client/company/audit/records";
const EVENTS = "/v1/dev/client/company/events";

// Hosted wiring: with lane ID's route table (#646) in front, the two reads need full access until a named company-read scope exists (the fixture's client has it).
describe("the company reads behind lane ID's route table", () => {
  it("refuses a client without full access, before anything is read", async () => {
    const at = new Date(T0 - 60_000).toISOString();
    db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://cloud.example.com/callback"], loopback: false, createdAt: at, updatedAt: at, updatedBy: "admin" });
    for (const path of [AUDIT, EVENTS]) {
      const read = await call("GET", path, await token());
      expect(read.status, path).toBe(403);
      expect(JSON.stringify(read.body)).not.toContain("evt_a");
    }
  });
});
type Records = { records: Array<{ eventId: string; actor: { developerId: string; name: string } }>; next?: string };

describe("the company audit read on the developer API", () => {
  it("answers an administrator the records of their own company, newest first, with the person's name", async () => {
    const read = await call("GET", AUDIT, await token());
    expect(read.status).toBe(200);
    expect((read.body as unknown as Records).records.map((record) => record.eventId)).toEqual(["evt_a1", "evt_a0"]);
    expect((read.body as unknown as Records).records[0]!.actor).toEqual({ developerId: ADA, name: "Ada", type: "person" });
  });

  it("answers the other administrator the other company", async () => {
    const read = await call("GET", AUDIT, await token({ sub: BO, sid: "s-bo" }));
    expect((read.body as unknown as Records).records.map((record) => record.eventId)).toEqual(["evt_b1", "evt_b0"]);
  });

  it("shows a person's name only for a person of the caller's own company", async () => {
    await seedAudit(store, COMPANY_A, { eventId: "evt_stranger", at: "2026-11-10T10:09:00.000Z", actor: { type: "person", id: BO } });
    const read = (await call("GET", AUDIT, await token())).body as unknown as Records;
    expect(read.records.find((record) => record.eventId === "evt_stranger")!.actor.name).toBe(BO);
    expect(read.records.find((record) => record.eventId === "evt_a0")!.actor.name).toBe("Ada");
  });

  it("filters and pages from the query string", async () => {
    const first = await call("GET", AUDIT, await token(), "limit=1");
    expect(first.status).toBe(200);
    expect((first.body as unknown as Records).records).toHaveLength(1);
    const second = await call("GET", AUDIT, await token(), `limit=1&cursor=${(first.body as unknown as Records).next!}`);
    const both = [...(first.body as unknown as Records).records, ...(second.body as unknown as Records).records].map((record) => record.eventId).sort();
    expect(both).toEqual(["evt_a0", "evt_a1"]);
    expect((await call("GET", AUDIT, await token(), "limit=0")).status).toBe(400);
  });

  it("refuses a person who is not an administrator with 403", async () => {
    expect((await call("GET", AUDIT, await token({ sub: CY, sid: "s-cy" }))).status).toBe(403);
  });

  it("refuses with the sign-in-again 401 when the person's company cannot be found", async () => {
    session("s-dee", "d".repeat(64), { administrator: true });
    db.set({ pk: `DEVELOPER#${"d".repeat(64)}`, sk: "META", developerId: "d".repeat(64), provider: "oidc", issuer: "https://idp.example.test", subject: "dee", displayName: "Dee", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    expect((await call("GET", AUDIT, await token({ sub: "d".repeat(64), sid: "s-dee" }))).status).toBe(401);
  });

  it("refuses a person whose sign-in has been withdrawn, even with a session that is still live", async () => {
    db.set({ pk: `DEVELOPER#${ADA}`, sk: "META", developerId: ADA, provider: "oidc", issuer: "https://idp.example.test", subject: "ada", displayName: "Ada", firstSignInAt: "x", lastSignInAt: "x", revoked: true });
    expect((await call("GET", AUDIT, await token())).status).toBe(401);
  });

  it("takes only GET", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) expect((await call(method, AUDIT, await token())).status, method).toBe(404);
  });

  it("refuses the other tokens the client routes refuse, with the same 401", async () => {
    expect((await call("GET", AUDIT, await token({ aud: "agentx-developer", azp: undefined }))).status).toBe(401);
    expect((await call("GET", AUDIT, await token({ aud: "someone-else" }))).status).toBe(401);
    session("s-ada", ADA, { administrator: true, revokedAt: new Date(T0).toISOString() });
    expect((await call("GET", AUDIT, await token())).status).toBe(401);
  });
});

// Audit gap 4 (2026-11-18): an owner or admin of a real company signs in without the built-in company's administrator flag; the host's live role reader lets them read their own company.
describe("the company reads for a live company owner or admin (no Rovara administrator flag)", () => {
  const DEE = "d".repeat(64);
  const roles: Record<string, { companyId: string; role: "owner" | "admin" | "member" }> = { [CY]: { companyId: COMPANY_A, role: "owner" }, [DEE]: { companyId: COMPANY_B, role: "member" } };
  const liveCompanyOf = async (developerId: string) => roles[developerId]?.companyId ?? (await companyOf(developerId));
  beforeEach(async () => {
    await broker({ clientRoutes: true, companyReads: { store, companyOf: liveCompanyOf, membershipOf: async (developerId: string) => roles[developerId] } });
    session("s-dee", DEE);
    db.set({ pk: `DEVELOPER#${DEE}`, sk: "META", developerId: DEE, provider: "oidc", issuer: "https://idp.example.test", subject: "dee", displayName: "Dee", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  });

  it("answers an owner their own company's records and events through the mounted route", async () => {
    const read = await call("GET", AUDIT, await token({ sub: CY, sid: "s-cy" }));
    expect(read.status).toBe(200);
    // The shared store holds company A's rows (and what earlier tests planted in A); never company B's.
    expect((read.body as unknown as Records).records.map((record) => record.eventId)).toEqual(expect.arrayContaining(["evt_a1", "evt_a0"]));
    expect(JSON.stringify(read.body)).not.toContain("evt_b");
    const events = await call("GET", EVENTS, await token({ sub: CY, sid: "s-cy" }), "from=2026-11-01T00%3A00%3A00.000Z");
    expect(events.status).toBe(200);
    expect(JSON.stringify(events.body)).not.toContain(COMPANY_B);
  });

  it("refuses a member of a company with 403, and still serves the Rovara administrator as before", async () => {
    const refused = await call("GET", AUDIT, await token({ sub: DEE, sid: "s-dee" }));
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).not.toContain("evt_b");
    expect(((await call("GET", AUDIT, await token())).body as unknown as Records).records.map((record) => record.eventId)).toEqual(expect.arrayContaining(["evt_a1", "evt_a0"]));
  });
});

describe("the company event read on the developer API", () => {
  const window = "from=2026-11-01T00%3A00%3A00.000Z&to=2026-11-30T00%3A00%3A00.000Z";
  type Events = { events: Array<{ orgId: string }>; next: string; hasMore: boolean };

  it("answers an administrator the events of their own company, with a cursor to poll with", async () => {
    const read = await call("GET", EVENTS, await token(), window);
    expect(read.status).toBe(200);
    expect((read.body as unknown as Events).events.map((event) => event.orgId)).toEqual([COMPANY_A]);
    const polled = await call("GET", EVENTS, await token(), `cursor=${(read.body as unknown as Events).next}`);
    expect(polled.status).toBe(200);
    expect((polled.body as unknown as Events).events).toEqual([]);
    const other = await call("GET", EVENTS, await token({ sub: BO, sid: "s-bo" }), window);
    expect((other.body as unknown as Events).events.map((event) => event.orgId)).toEqual([COMPANY_B]);
  });

  it("refuses a person who is not an administrator with 403, and a missing window with 400", async () => {
    expect((await call("GET", EVENTS, await token({ sub: CY, sid: "s-cy" }), window)).status).toBe(403);
    expect((await call("GET", EVENTS, await token())).status).toBe(400);
  });
});

describe("the reads are off unless the host wires them", () => {
  it("answers 404 when the install gives the routes no store", async () => {
    await broker({ clientRoutes: true });
    expect((await call("GET", AUDIT, await token())).status).toBe(404);
    expect((await call("GET", EVENTS, await token(), "from=2026-11-01T00%3A00%3A00.000Z")).status).toBe(404);
  });

  it("answers 404 when the client routes are off, even with a store", async () => {
    await broker({ companyReads: { store, companyOf } });
    expect((await call("GET", AUDIT, await token())).status).toBe(404);
  });

  it("serves one company, the implicit one, when the host gives a store and no resolver", async () => {
    await broker({ clientRoutes: true, companyReads: { store } });
    const read = await call("GET", AUDIT, await token());
    expect(read.status).toBe(200);
    expect((read.body as unknown as Records).records).toEqual([]);
    await seedAudit(store, IMPLICIT_COMPANY_ID, { eventId: "evt_implicit", at: "2026-11-10T10:05:00.000Z", actor: { type: "person", id: ADA } });
    expect(((await call("GET", AUDIT, await token())).body as unknown as Records).records.map((record) => record.eventId)).toEqual(["evt_implicit"]);
  });
});
