import { expect, it, vi } from "vitest";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { IMPLICIT_COMPANY_ID, SignInClientRecordSchema, signInClientKey } from "@agentx/contracts";
import { signinCompanyWorld } from "../support/signin-company-world.js";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { httpEvent, authorizeQuery, VERIFIER } from "../support/developer-fakes.js";

const A = COMPANY_A.orgId, B = COMPANY_B.orgId;
const at = "2026-01-01T00:00:00.000Z";
const client = (clientId = "web-app", audience = clientId) => ({ clientId, audience, name: "Web", redirectUris: [], loopback: true, createdAt: at, updatedAt: at, updatedBy: "operator" });
const call = (h: ReturnType<typeof signinCompanyWorld>, event: unknown) => h.handler(event as Parameters<typeof h.handler>[0]);
const put = (h: ReturnType<typeof signinCompanyWorld>, companyId: string, clientId = "web-app", audience = clientId) => call(h, { kind: "put-sign-in-client", companyId, client: { ...client(clientId, audience), companyId } });
const list = (h: ReturnType<typeof signinCompanyWorld>, companyId: string) => call(h, { kind: "list-sign-in-clients", companyId });
const remove = (h: ReturnType<typeof signinCompanyWorld>, companyId: string, clientId = "web-app") => call(h, { kind: "remove-sign-in-client", companyId, clientId });

it("strict records accept either company ownership or operator install level, never both", () => {
  expect(SignInClientRecordSchema.safeParse({ ...client(), companyId: A }).success).toBe(true);
  expect(SignInClientRecordSchema.safeParse({ ...client(), installLevel: true }).success).toBe(true);
  for (const extra of [{ companyId: A, installLevel: true }, { companyId: "bad" }, { installLevel: false }, { extra: true }]) expect(SignInClientRecordSchema.safeParse({ ...client(), ...extra }).success).toBe(false);
});

it("company registry filters get/list, preserves foreign rows, and gives fixed collision/refusal bytes", async () => {
  const h = signinCompanyWorld();
  expect(await put(h, A)).toEqual({ ok: true });
  expect(await h.deps.store.getClient("web-app", A)).toMatchObject({ companyId: A });
  expect(await h.deps.store.getClient("web-app", B)).toBeUndefined();
  expect(await list(h, B)).toEqual({ ok: true, clients: [] });
  const foreign = await put(h, B);
  expect(foreign).toEqual({ ok: false, error: "invalid_request" });
  expect(await put(h, B, "other-app", "web-app")).toEqual(foreign);
  expect(await put(h, B, "agentx-cli")).toEqual(foreign);
  expect(await remove(h, B)).toEqual(await remove(h, B, "missing-app"));
  expect(await h.deps.store.getClient("web-app", A)).toMatchObject({ companyId: A });
  expect(await remove(h, A)).toEqual({ ok: true, removed: true });
});

it("serializes two different ids with one audience in one revision transaction", async () => {
  const h = signinCompanyWorld();
  // Both snapshots finish before either transaction. A list-then-put loses this race.
  const send = h.db.send.bind(h.db);
  let arrived = 0; let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  vi.spyOn(h.db, "send").mockImplementation(async (command) => {
    const answer = await send(command);
    if (command instanceof QueryCommand) { if (++arrived === 2) release(); await barrier; }
    return answer;
  });
  const answers = await Promise.all([put(h, A, "first-app", "shared-audience"), put(h, B, "second-app", "shared-audience")]);
  expect(answers.filter((answer) => "ok" in answer && answer.ok)).toHaveLength(1);
  expect(h.db.find((row) => row.entityType === "SIGN_IN_CLIENT")).toHaveLength(1);
  expect(h.db.get("SIGNIN_CLIENTS", "REVISION")).toMatchObject({ entityType: "SIGN_IN_CLIENT_REGISTRY", revision: expect.any(String) as unknown });
});

it("reads revision before snapshot and rejects a writer that changes it during the snapshot", async () => {
  const h = signinCompanyWorld(); expect(await put(h, A)).toEqual({ ok: true });
  const send = h.db.send.bind(h.db); const order: string[] = [];
  vi.spyOn(h.db, "send").mockImplementation(async (command) => {
    if (command instanceof GetCommand && command.input.Key?.sk === "REVISION") order.push("revision");
    if (command instanceof QueryCommand) {
      order.push("snapshot");
      h.db.set({ ...h.db.get("SIGNIN_CLIENTS", "REVISION")!, revision: "00000000-0000-4000-8000-000000000099" });
    }
    return send(command);
  });
  expect(await put(h, B, "second-app")).toEqual({ ok: false, error: "invalid_request" });
  expect(order).toEqual(["revision", "snapshot"]);
  expect(h.db.get("SIGNIN_CLIENTS", "CLIENT#second-app")).toBeUndefined();
});

it.each(["malformed", "duplicate", "missing", "paginated", "over-limit", "bytes", "time", "denied"])("refuses the whole registry on %s without leaks", async (damage) => {
  const h = signinCompanyWorld(); expect(await put(h, A)).toEqual({ ok: true });
  const send = h.db.send.bind(h.db);
  vi.spyOn(h.db, "send").mockImplementation(async (command) => {
    if (!(command instanceof QueryCommand)) return send(command);
    const row = h.db.get("SIGNIN_CLIENTS", "CLIENT#web-app")!;
    if (damage === "denied") throw new Error("private-canary");
    if (damage === "time") h.tick(10_001);
    return damage === "missing" ? {} : { Items: damage === "malformed" ? [{ ...row, companyId: "private-canary" }] : damage === "duplicate" ? [row, row] : damage === "over-limit" ? Array.from({ length: 102 }, () => row) : damage === "bytes" ? [{ ...row, name: "private-canary".repeat(100_000) }] : [row], ...(damage === "paginated" ? { LastEvaluatedKey: { pk: "private-canary" } } : {}) };
  });
  expect(await list(h, A)).toEqual({ ok: false, error: "unavailable" });
  expect(await put(h, B, "second-app")).toEqual({ ok: false, error: "invalid_request" });
  expect(await remove(h, A)).toEqual({ ok: false, error: "invalid_request" });
  expect(h.db.get("SIGNIN_CLIENTS", "CLIENT#web-app")).toBeDefined();
});

it("accepts exactly 100 clients but refuses a 101st; legacy rows are implicit", async () => {
  const h = signinCompanyWorld();
  for (let i = 0; i < 100; i++) h.db.set({ ...signInClientKey(`app-${i}`), entityType: "SIGN_IN_CLIENT", ...client(`app-${i}`) });
  expect(await list(h, IMPLICIT_COMPANY_ID)).toMatchObject({ ok: true, clients: expect.any(Array) as unknown });
  expect(await list(h, A)).toEqual({ ok: true, clients: [] });
  expect(await put(h, A, "overflow-app")).toEqual({ ok: false, error: "invalid_request" });
  expect(await put(h, IMPLICIT_COMPANY_ID, "app-0")).toEqual({ ok: true });
});

it("only the operator installs an install-level client; company lists hide it", async () => {
  const h = signinCompanyWorld();
  expect(await call(h, { kind: "put-sign-in-client", companyId: A, client: { ...client(), installLevel: true } })).toEqual({ ok: false, error: "invalid_request" });
  expect(await call(h, { kind: "company-signin-client-set", client: { ...client(), installLevel: true } })).toEqual({ ok: true });
  expect(await list(h, A)).toEqual({ ok: true, clients: [] });
  expect(await list(h, IMPLICIT_COMPANY_ID)).toEqual({ ok: true, clients: [] });
  expect(await remove(h, A)).toEqual({ ok: true, removed: false });
  expect(h.db.find((row) => row.event === "company-signin-client-set")).toHaveLength(1);
});

const codeOf = (answer: { headers: Record<string, string> }) => new URL(answer.headers.location!).searchParams.get("code")!;
const exchange = (h: ReturnType<typeof signinCompanyWorld>, code: string, clientId = "web-app") => h.http(httpEvent("POST", "/v1/auth/token", { grant_type: "authorization_code", client_id: clientId, code, code_verifier: VERIFIER, redirect_uri: "http://127.0.0.1:49152/callback" }));
it("company client selects its issuer and binds code and refresh to live membership", async () => {
  const h = signinCompanyWorld(); await h.create(A); await h.create(B);
  expect(await put(h, A)).toEqual({ ok: true });
  const wrong = await h.http(httpEvent("GET", authorizeQuery({ client_id: "web-app", company: B })));
  const unknown = await h.http(httpEvent("GET", authorizeQuery({ company: "org_" + "z".repeat(20) })));
  expect(wrong).toEqual(unknown);
  const signed = await h.signInCompany(A, "person", "shared@example.test", { client_id: "web-app" });
  const minted = await exchange(h, codeOf(signed)); expect(minted.statusCode).toBe(200);
  const second = await h.signInCompany(A, "person", "shared@example.test", { client_id: "web-app" });
  const member = h.db.find((row) => row.entityType === "COMPANY_MEMBERSHIP")[0]!;
  h.db.set({ ...member, companyId: B });
  expect((await exchange(h, codeOf(second))).statusCode).toBe(400);
  const refreshed = await h.http(httpEvent("POST", "/v1/auth/token", { grant_type: "refresh_token", client_id: "web-app", refresh_token: (JSON.parse(minted.body) as { refresh_token: string }).refresh_token }));
  expect(refreshed.statusCode).toBe(400);
  expect(h.db.find((row) => row.entityType === "SESSION")[0]?.revokedReason).toBe("company_changed");
});

it("install-level client signs in each company's verified member", async () => {
  const h = signinCompanyWorld(); await h.create(A); await h.create(B);
  expect(await call(h, { kind: "company-signin-client-set", client: { ...client(), installLevel: true } })).toEqual({ ok: true });
  for (const c of [A, B]) expect((await exchange(h, codeOf(await h.signInCompany(c, "person", "shared@example.test", { client_id: "web-app" })))).statusCode).toBe(200);
});

 it.each(["token", "id"] as const)("access %s refuses foreign membership with unknown-person bytes", async (via) => {
  const { companyRouteHarness, PERSON, TIME } = await import("../support/company-route-harness.js");
  const h = companyRouteHarness(); h.project(A);
  const secret = ["test", "secret"].join("-");
  const { createHash } = await import("node:crypto");
  h.db.set({ ...signInClientKey("web-app"), entityType: "SIGN_IN_CLIENT", ...client(), companyId: A, secretHash: createHash("sha256").update(secret).digest("hex") });
  h.db.set({ ...h.db.get("SESSION#session", "META")!, clientId: "web-app", startedAt: TIME });
  Object.assign(h.claims, { azp: "web-app", aud: "web-app" });
  const token = `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(h.claims)).toString("base64url")}.c2ln`;
  const options = { method: "POST", headers: { authorization: via === "token" ? `Bearer ${token}` : `Basic ${Buffer.from(`web-app:${secret}`).toString("base64")}` }, body: JSON.stringify(via === "id" ? { developerId: PERSON } : {}) };
  h.deps.companies = { companyOf: async () => A, membershipOf: async () => ({ companyId: A, role: "member" as const }) };
  if (via === "token") {
    h.deps.developer.clientRoutes = true;
    expect((await h.read("/v1/dev/client/projects/shared-project", { headers: options.headers })).statusCode).toBe(200);
  }
  expect((await h.read("/v1/dev/access", options)).statusCode).toBe(200);
  h.deps.companies = { companyOf: async () => B };
  const foreign = await h.read("/v1/dev/access", options); expect(foreign.statusCode).toBe(401);
  if (via === "token") expect((await h.read("/v1/dev/client/projects/shared-project", { headers: options.headers })).statusCode).toBe(401);
  for (const companyOf of [async () => undefined, async () => "bad", async (): Promise<string> => { throw new Error("private-canary"); }]) {
    h.deps.companies = { companyOf }; expect(await h.read("/v1/dev/access", options)).toEqual(foreign);
  }
  expect(foreign.body).not.toMatch(/private-canary|org_/);
});

it("client planners and production admin list take the caller membership company", async () => {
  const { createAdminReadBroker } = await import("../support/admin-read-broker.js");
  const { planChange } = await import("../../packages/broker/src/aws/admin-change-plans.js");
  const { signInClientsThroughLambda } = await import("../../packages/broker/src/aws/developer-routes.js");
  const h = signinCompanyWorld();
  const registry = signInClientsThroughLambda(async (payload) => ({ Payload: Buffer.from(JSON.stringify(await call(h, JSON.parse(Buffer.from(payload).toString())))) }));
  const companyReader = { companyOf: async () => A };
  const broker = await createAdminReadBroker({ developerExtra: { signInClients: registry, companies: companyReader } });
  const module = await import("../../packages/broker/src/aws/broker.js");
  const deps = module.createPlanDependencies(broker.brokerInput as never);
  expect(deps.actions.companies).toBe(companyReader);
  const identity = { issuer: "https://identity.example.test", subject: "admin-subject", ownerKey: "a".repeat(64), isAdministrator: true, claims: { companyId: B } };
  deps.actions.companies = { companyOf: async () => A };
  const registration = { name: "Web", audience: "web-app", redirectUris: [], loopback: true };
  const plan = await planChange(deps, identity, { kind: "register_sign_in_client", clientId: "web-app", registration });
  await plan.apply(identity);
  const replacement = await planChange(deps, identity, { kind: "register_sign_in_client", clientId: "web-app", registration });
  expect(replacement.effect).toMatch(/^Replace /);
  expect(replacement.snapshot).toMatchObject({ client: { companyId: A } });
  expect(await list(h, A)).toMatchObject({ ok: true, clients: [expect.objectContaining({ companyId: A })] });
  expect((await broker.admin("GET", "/v1/admin/sign-in-clients")).body.clients).toEqual([expect.objectContaining({ companyId: A })]);
  companyReader.companyOf = async () => B;
  expect((await broker.admin("GET", "/v1/admin/sign-in-clients")).body.clients).toEqual([]);
  deps.actions.companies = { companyOf: async () => B };
  await expect(planChange(deps, identity, { kind: "remove_sign_in_client", clientId: "web-app" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  deps.actions.companies = { companyOf: async () => A };
  const removal = await planChange(deps, identity, { kind: "remove_sign_in_client", clientId: "web-app" });
  expect(await removal.apply(identity)).toMatchObject({ removed: true });
});

it("a missing or malformed revision snapshot never proves a registry mutation", async () => {
  for (const damage of ["missing", "malformed"] as const) {
    const h = signinCompanyWorld(); expect(await put(h, A)).toEqual({ ok: true });
    if (damage === "malformed") h.db.set({ pk: "SIGNIN_CLIENTS", sk: "REVISION", entityType: "OTHER", revision: "private-canary" });
    else {
      const send = h.db.send.bind(h.db);
      vi.spyOn(h.db, "send").mockImplementation(async (command) => command instanceof QueryCommand ? { Items: [h.db.get("SIGNIN_CLIENTS", "CLIENT#web-app")] } : send(command));
    }
    expect(await put(h, B, "second-app")).toEqual({ ok: false, error: "invalid_request" });
    expect(await remove(h, A)).toEqual({ ok: false, error: "invalid_request" });
  }
});

it("authorizing without a selector uses the company's registered issuer", async () => {
  const h = signinCompanyWorld(); await h.create(A); expect(await put(h, A)).toEqual({ ok: true });
  const answer = await h.http(httpEvent("GET", authorizeQuery({ client_id: "web-app" })));
  expect(answer.statusCode).toBe(200);
  expect(h.db.find((row) => row.entityType === "AUTH_REQUEST")[0]?.companyId).toBe(A);
});

it("a client's stolen code or refresh cannot mint for a foreign company's member", async () => {
  const h = signinCompanyWorld(); await h.create(A); await h.create(B);
  expect(await put(h, A)).toEqual({ ok: true }); expect(await put(h, B, "other-app")).toEqual({ ok: true });
  const foreign = await h.signInCompany(B, "person", "shared@example.test", { client_id: "other-app" });
  const code = codeOf(foreign);
  const stored = h.db.find((row) => row.entityType === "AUTH_CODE")[0]!;
  // Even a stolen record carrying the right client id is fenced by the live company.
  h.db.set({ ...stored, clientId: "web-app" });
  expect((await exchange(h, code)).statusCode).toBe(400);
  const signed = await h.signInCompany(B, "person", "shared@example.test", { client_id: "other-app" });
  const minted = await exchange(h, codeOf(signed), "other-app"); expect(minted.statusCode).toBe(200);
  const session = h.db.find((row) => row.entityType === "SESSION")[0]!; h.db.set({ ...session, clientId: "web-app" });
  expect((await h.http(httpEvent("POST", "/v1/auth/token", { grant_type: "refresh_token", client_id: "web-app", refresh_token: (JSON.parse(minted.body) as { refresh_token: string }).refresh_token }))).statusCode).toBe(400);
});

it("the web app marker is the operator's, on an install-level client: a company administrator's write is refused whatever it names (DEC 236h)", async () => {
  const h = signinCompanyWorld();
  const webApp = { ...client(), fullAccess: true, secretHash: "f".repeat(64), webApp: true };
  // A company's own write, by the sign-in server's put event: refused, nothing stored.
  expect(await call(h, { kind: "put-sign-in-client", companyId: A, client: { ...webApp, companyId: A } })).toEqual({ ok: false, error: "invalid_request" });
  expect(h.db.get("SIGNIN_CLIENTS", "CLIENT#web-app")).toBeUndefined();
  // The operator's write of a client that is not install-level (the implicit company's own) is refused too: the marker belongs only on an install-level client.
  expect(await call(h, { kind: "company-signin-client-set", client: { ...webApp } })).toEqual({ ok: false, error: "unavailable" });
  expect(h.db.get("SIGNIN_CLIENTS", "CLIENT#web-app")).toBeUndefined();
  // The operator's install-level client carries it.
  expect(await call(h, { kind: "company-signin-client-set", client: { ...webApp, installLevel: true } })).toEqual({ ok: true });
  expect(h.db.get("SIGNIN_CLIENTS", "CLIENT#web-app")).toMatchObject({ webApp: true, installLevel: true });
});

it.each(["keep-secret", "owner-mismatch", "full-access", "install-level"])("rejects unsafe %s updates before modifying a row", async (damage) => {
  const h = signinCompanyWorld(); expect(await put(h, A)).toEqual({ ok: true });
  const before = h.db.get("SIGNIN_CLIENTS", "CLIENT#web-app");
  const extra = damage === "owner-mismatch" ? { companyId: B } : damage === "full-access" ? { fullAccess: true } : damage === "install-level" ? { companyId: undefined, installLevel: true } : {};
  expect(await call(h, { kind: "put-sign-in-client", companyId: A, client: { ...client(), companyId: A, ...extra }, ...(damage === "keep-secret" ? { keepSecret: true } : {}) })).toEqual({ ok: false, error: "invalid_request" });
  expect(h.db.get("SIGNIN_CLIENTS", "CLIENT#web-app")).toEqual(before);
});

it("keeps a company's own secret atomically and refuses a foreign keep-secret", async () => {
  const h = signinCompanyWorld(); const record = { ...client(), companyId: A, secretHash: "f".repeat(64) };
  expect(await call(h, { kind: "put-sign-in-client", companyId: A, client: record })).toEqual({ ok: true });
  expect(await call(h, { kind: "put-sign-in-client", companyId: A, client: { ...client(), companyId: A }, keepSecret: true })).toEqual({ ok: true });
  expect((await h.deps.store.getClient("web-app", A))?.secretHash).toBe(record.secretHash);
  expect(await call(h, { kind: "put-sign-in-client", companyId: B, client: { ...client(), companyId: B }, keepSecret: true })).toEqual({ ok: false, error: "invalid_request" });
});

it.each([{ entityType: "OTHER" }, { clientId: "other-app" }])("unreadable client metadata cannot select a company method: %j", async (damage) => {
  const h = signinCompanyWorld(); await h.create(A); expect(await put(h, A)).toEqual({ ok: true });
  const row = h.db.get("SIGNIN_CLIENTS", "CLIENT#web-app")!; h.db.set({ ...row, ...damage });
  expect(await h.deps.store.getClient("web-app", A)).toBeUndefined();
  expect((await h.http(httpEvent("GET", authorizeQuery({ client_id: "web-app" })))).statusCode).toBe(400);
});

it.each(["put", "remove"] as const)("a late revision conflict rolls back the entire %s", async (operation) => {
  const h = signinCompanyWorld(); expect(await put(h, A)).toEqual({ ok: true });
  const before = h.db.get("SIGNIN_CLIENTS", "CLIENT#web-app");
  const send = h.db.send.bind(h.db); let changed = false;
  vi.spyOn(h.db, "send").mockImplementation(async (command) => {
    if (command.constructor.name === "TransactWriteCommand" && !changed) {
      changed = true; h.db.set({ ...h.db.get("SIGNIN_CLIENTS", "REVISION")!, revision: "00000000-0000-4000-8000-000000000098" });
    }
    return send(command);
  });
  const answer = operation === "put" ? await call(h, { kind: "put-sign-in-client", companyId: A, client: { ...client(), companyId: A, name: "Replacement" } }) : await remove(h, A);
  expect(answer).toEqual({ ok: false, error: "invalid_request" });
  expect(h.db.get("SIGNIN_CLIENTS", "CLIENT#web-app")).toEqual(before);
});

it("the total registry byte cap applies across valid rows under the item limit", async () => {
  const h = signinCompanyWorld();
  for (let i = 0; i < 50; i++) h.db.set({ ...signInClientKey(`app-${i}`), entityType: "SIGN_IN_CLIENT", ...client(`app-${i}`), redirectUris: Array.from({ length: 10 }, () => "x".repeat(2_000)) });
  expect(await list(h, IMPLICIT_COMPANY_ID)).toEqual({ ok: false, error: "unavailable" });
  expect(await put(h, A)).toEqual({ ok: false, error: "invalid_request" });
});

it("a client reassigned during the provider callback cannot join or write a profile", async () => {
  const h = signinCompanyWorld(); await h.create(A); expect(await put(h, A)).toEqual({ ok: true });
  h.db.onWrite(({ after }) => {
    if (after?.entityType === "AUTH_REQUEST" && after.consumedAt !== undefined) h.db.set({ ...h.db.get("SIGNIN_CLIENTS", "CLIENT#web-app")!, companyId: B });
  });
  const answer = await h.signInCompany(A, "person", "shared@example.test", { client_id: "web-app" });
  expect(new URL(answer.headers.location!).searchParams.get("error_description")).toBe("not invited");
  expect(h.db.find((row) => ["DEVELOPER", "AUTH_CODE", "COMPANY_MEMBERSHIP"].includes(String(row.entityType)))).toEqual([]);
});
it("a 101-row complete snapshot is refused even without a revision row", async () => {
  const h = signinCompanyWorld();
  for (let i = 0; i < 101; i++) h.db.set({ ...signInClientKey(`app-${i}`), entityType: "SIGN_IN_CLIENT", ...client(`app-${i}`) });
  expect(await list(h, IMPLICIT_COMPANY_ID)).toEqual({ ok: false, error: "unavailable" });
});
it.each([{ entityType: "OTHER" }, { sk: "WRONG" }])("registry snapshot runtime validates row identity: %j", async (damage) => {
  const h = signinCompanyWorld(); const send = h.db.send.bind(h.db);
  vi.spyOn(h.db, "send").mockImplementation(async (command) => command instanceof QueryCommand ? { Items: [{ ...signInClientKey("web-app"), entityType: "SIGN_IN_CLIENT", ...client(), ...damage }] } : send(command));
  expect(await list(h, IMPLICIT_COMPANY_ID)).toEqual({ ok: false, error: "unavailable" });
});
