// DEC 254a: operator invite codes for self-serve company sign-up. Stored by hash only, single-use, expiring, revocable, listed without the
// code, with an install-level audit row per create, revoke and use, and an operator switch for self-serve (absent = open).
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { COMPANY_INVITE_CODE_PREFIX, companyInviteCodeHash, companyInviteCodeId, newCompanyInviteCode, type AdminChangeInput } from "@agentx/contracts";
import { companyInvitesThroughLambda } from "../../packages/broker/src/aws/developer-routes.js";
import { CompanyInviteStore, INVITE_CODES_PK, INVITE_LOG_PK, SELF_SERVE_KEY, companyInviteKey } from "../../packages/broker/src/developer/company-invites.js";
import { CompanySignInStore } from "../../packages/broker/src/developer/company-membership.js";
import { companyOperator } from "../../packages/broker/src/developer/company-operator.js";
import { tokenStoreKey } from "../../packages/cli/src/auth.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
import { createAdminChangeBroker } from "../support/admin-change-broker.js";
import { identityHarness } from "../support/developer-fakes.js";

const ADMIN = "a".repeat(64);
function world() {
  const h = identityHarness({ oidc: {} });
  const company = new CompanySignInStore({ documentClient: h.db, tableName: "signin", now: h.now });
  const invites = new CompanyInviteStore({ documentClient: h.db, tableName: "signin", now: h.now, company, selfServeAllowed: true });
  h.deps.company = company; h.deps.companyInvites = invites;
  const call = (event: unknown) => companyOperator({ store: company, invites, now: h.now, log: h.deps.log }, event);
  const codes = () => h.db.find((row) => row.pk === INVITE_CODES_PK);
  const audit = () => h.db.find((row) => row.pk === INVITE_LOG_PK);
  return { ...h, company, invites, call, codes, audit };
}

describe("invite codes are stored by hash only", () => {
  it("a new code is >=128 random bits, URL-safe, with a fixed prefix; only its hash and id leave the maker", () => {
    const made = newCompanyInviteCode();
    expect(made.code.startsWith(COMPANY_INVITE_CODE_PREFIX)).toBe(true);
    expect(made.code.slice(COMPANY_INVITE_CODE_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(made.codeHash).toBe(companyInviteCodeHash(made.code));
    expect(made.codeId).toBe(made.codeHash.slice(0, 16));
    expect(newCompanyInviteCode().code).not.toBe(made.code);
  });

  it("create stores the hash with status, expiry and creator, and writes its audit row in the same transaction", async () => {
    const h = world(); const made = newCompanyInviteCode();
    expect(await h.call({ kind: "company-invite-create", codeHash: made.codeHash, expiresInHours: 24, createdBy: ADMIN })).toEqual({ ok: true, codeId: made.codeId });
    expect(h.codes()).toEqual([{ ...companyInviteKey(made.codeHash), entityType: "COMPANY_INVITE_CODE", status: "live", expiresAt: Math.floor(h.now() / 1000) + 24 * 3600, createdAt: new Date(h.now()).toISOString(), createdBy: ADMIN }]);
    expect(h.audit()).toEqual([expect.objectContaining({ entityType: "COMPANY_INVITE_LOG", event: "company-invite-create", codeId: made.codeId, createdBy: ADMIN })]);
    // The code itself is nowhere: not in a row, not in a log line.
    expect(JSON.stringify(h.db.find(() => true))).not.toContain(made.code);
    expect(JSON.stringify(h.logs)).not.toContain(made.code);
    expect(JSON.stringify(h.logs)).not.toContain(made.codeHash);
    // A repeat of one hash is refused, never an overwrite.
    expect(await h.call({ kind: "company-invite-create", codeHash: made.codeHash, expiresInHours: 1 })).toEqual({ ok: false, error: "unavailable" });
    expect(h.codes()[0]!.expiresAt).toBe(Math.floor(h.now() / 1000) + 24 * 3600);
    expect(h.audit()).toHaveLength(1);
  });

  it.each([0, 721, 1.5, "24"])("refuses an expiry outside 1 to 720 whole hours (%j)", async (hours) => {
    const h = world();
    expect(await h.call({ kind: "company-invite-create", codeHash: newCompanyInviteCode().codeHash, expiresInHours: hours })).toEqual({ ok: false, error: "invalid_request" });
    expect(h.codes()).toEqual([]);
  });

  it("refuses a plaintext code or any extra field in the event", async () => {
    const h = world(); const made = newCompanyInviteCode();
    for (const event of [{ kind: "company-invite-create", codeHash: made.code, expiresInHours: 1 }, { kind: "company-invite-create", codeHash: made.codeHash, expiresInHours: 1, code: made.code }]) {
      expect(await h.call(event)).toEqual({ ok: false, error: "invalid_request" });
    }
    expect(h.codes()).toEqual([]);
  });
});

describe("list, revoke and the self-serve switch", () => {
  it("lists ids, status and times, never a code or a full hash; expired is shown as expired", async () => {
    const h = world(); const one = newCompanyInviteCode(), two = newCompanyInviteCode();
    await h.call({ kind: "company-invite-create", codeHash: one.codeHash, expiresInHours: 1 });
    await h.call({ kind: "company-invite-create", codeHash: two.codeHash, expiresInHours: 48 });
    h.tick(2 * 3600_000);
    const listed = await h.call({ kind: "company-invite-list" }) as { ok: true; invites: Array<{ codeId: string; status: string }>; selfServe: string; more: boolean };
    expect(listed.selfServe).toBe("open"); expect(listed.more).toBe(false);
    expect(Object.fromEntries(listed.invites.map((invite) => [invite.codeId, invite.status]))).toEqual({ [one.codeId]: "expired", [two.codeId]: "live" });
    for (const secret of [one.code, two.code, one.codeHash, two.codeHash]) expect(JSON.stringify(listed)).not.toContain(secret);
  });

  it("an unreadable stored code refuses the whole list (no partial answer)", async () => {
    const h = world(); const made = newCompanyInviteCode();
    await h.call({ kind: "company-invite-create", codeHash: made.codeHash, expiresInHours: 1 });
    h.db.set({ ...h.codes()[0]!, status: "unknown" });
    expect(await h.call({ kind: "company-invite-list" })).toEqual({ ok: false, error: "unavailable" });
  });

  it("revoke is conditional on a live code, writes its audit row, and a used or revoked code is not found", async () => {
    const h = world(); const made = newCompanyInviteCode();
    await h.call({ kind: "company-invite-create", codeHash: made.codeHash, expiresInHours: 24 });
    expect(await h.call({ kind: "company-invite-revoke", codeId: "0".repeat(16) })).toEqual({ ok: false, error: "not_found" });
    expect(await h.call({ kind: "company-invite-revoke", codeId: made.codeId, createdBy: ADMIN })).toEqual({ ok: true });
    expect(h.codes()[0]).toMatchObject({ status: "revoked", revokedBy: ADMIN, revokedAt: new Date(h.now()).toISOString() });
    expect(h.audit().map((row) => row.event)).toEqual(["company-invite-create", "company-invite-revoke"]);
    expect(await h.call({ kind: "company-invite-revoke", codeId: made.codeId })).toEqual({ ok: false, error: "not_found" });
    h.db.set({ ...h.codes()[0]!, status: "used" });
    expect(await h.call({ kind: "company-invite-revoke", codeId: made.codeId })).toEqual({ ok: false, error: "not_found" });
    expect(h.audit()).toHaveLength(2);
  });

  it("a revoke that loses a race to a use changes nothing", async () => {
    const h = world(); const made = newCompanyInviteCode();
    await h.call({ kind: "company-invite-create", codeHash: made.codeHash, expiresInHours: 24 });
    const send = h.db.send.bind(h.db);
    // The code is used between the revoke's read and its write.
    vi.spyOn(h.db, "send").mockImplementationOnce(async (command) => { const answer = await send(command); h.db.set({ ...h.codes()[0]!, status: "used" }); return answer; });
    expect(await h.invites.revoke(made.codeId)).toBe(false);
    expect(h.codes()[0]).toMatchObject({ status: "used" });
    expect(h.audit().map((row) => row.event)).toEqual(["company-invite-create"]);
  });

  it("self-serve is open when never set, closes and opens with an audit row, and an unreadable setting reads as closed", async () => {
    const h = world();
    expect(await h.invites.selfServeOpen()).toBe(true);
    expect(await h.call({ kind: "company-self-serve-set", open: false, createdBy: ADMIN })).toEqual({ ok: true });
    expect(await h.invites.selfServeOpen()).toBe(false);
    expect(h.audit()).toEqual([expect.objectContaining({ event: "company-self-serve-set", open: false, createdBy: ADMIN })]);
    await h.call({ kind: "company-self-serve-set", open: true });
    expect(await h.invites.selfServeOpen()).toBe(true);
    h.db.set({ ...SELF_SERVE_KEY, entityType: "COMPANY_SELF_SERVE_SETTING", open: "yes" });
    expect(await h.invites.selfServeOpen()).toBe(false);
    expect((await h.call({ kind: "company-invite-list" }) as { selfServe: string }).selfServe).toBe("closed");
  });

  it("without the company layer the events are unknown, and without the invite store they are unavailable", async () => {
    const h = identityHarness();
    expect(await h.handler({ kind: "company-invite-list" } as never)).toEqual({ ok: false, error: "invalid_request" });
    const company = new CompanySignInStore({ documentClient: h.db, tableName: "signin", now: h.now });
    expect(await companyOperator({ store: company, now: h.now, log: () => undefined }, { kind: "company-invite-list" })).toEqual({ ok: false, error: "unavailable" });
  });
});

describe("an install administrator's changes and list", () => {
  function registryOverIdentity() {
    const h = world();
    const registry = companyInvitesThroughLambda(async (payload) => ({ Payload: new TextEncoder().encode(JSON.stringify(await h.handler(JSON.parse(new TextDecoder().decode(payload)) as never))) }));
    return { h, registry };
  }
  async function setUp() {
    const { h, registry } = registryOverIdentity();
    const harness = await createAdminChangeBroker({ companyInvites: registry });
    const change = async (input: AdminChangeInput, subject?: string) => {
      const planned = await harness.propose(input, ["cli"], undefined, subject);
      return { planned, apply: () => harness.apply((planned.body.change as { changeId: string }).changeId, "cli", subject) };
    };
    return { h, harness, change };
  }

  it("create shows only the code id, stores the code once applied, and the list shows it without its hash", async () => {
    const { h, harness, change } = await setUp(); const made = newCompanyInviteCode();
    const { planned, apply } = await change({ kind: "create_company_invite", codeHash: made.codeHash, expiresInHours: 72 });
    expect(planned.status).toBe(201);
    const view = planned.body.change as { effect: string; details: unknown };
    expect(view.effect).toContain(`Make company invite code ${made.codeId}`);
    expect(JSON.stringify(view)).not.toContain(made.codeHash);
    expect(h.codes()).toEqual([]);
    expect((await apply()).body.change).toMatchObject({ status: "applied" });
    expect(h.codes()).toEqual([expect.objectContaining({ sk: `CODE#${made.codeHash}`, status: "live" })]);
    // The applier is recorded as the creator, never "operator".
    expect(h.codes()[0]!.createdBy).toMatch(/^[a-f0-9]{64}$/);
    const listed = await harness.admin("GET", "/v1/admin/company-invites");
    expect(listed.body).toMatchObject({ invites: [{ codeId: made.codeId, status: "live" }], selfServe: "open", more: false });
    expect(JSON.stringify(listed.body)).not.toContain(made.codeHash);
  });

  it("revoke and the self-serve switch are changes too; revoke of an unknown id changes nothing", async () => {
    const { h, harness, change } = await setUp(); const made = newCompanyInviteCode();
    await (await change({ kind: "create_company_invite", codeHash: made.codeHash, expiresInHours: 1 })).apply();
    const missing = await change({ kind: "revoke_company_invite", codeId: "f".repeat(16) });
    expect((await missing.apply()).body.change).not.toMatchObject({ status: "applied" });
    expect(h.codes()[0]).toMatchObject({ status: "live" });
    expect((await (await change({ kind: "revoke_company_invite", codeId: made.codeId })).apply()).body.change).toMatchObject({ status: "applied" });
    expect(h.codes()[0]).toMatchObject({ status: "revoked" });
    const closing = await change({ kind: "set_company_self_serve", open: false });
    expect((closing.planned.body.change as { effect: string }).effect).toContain("Close self-serve company sign-up");
    await closing.apply();
    expect((await harness.admin("GET", "/v1/admin/company-invites")).body).toMatchObject({ selfServe: "closed" });
  });

  it("the kill switch and a revoke still work when the code list cannot be read", async () => {
    const { h, change } = await setUp(); const made = newCompanyInviteCode();
    await (await change({ kind: "create_company_invite", codeHash: made.codeHash, expiresInHours: 1 })).apply();
    h.db.set({ pk: INVITE_CODES_PK, sk: `CODE#${"0".repeat(64)}`, entityType: "COMPANY_INVITE_CODE", status: "unreadable" });
    expect((await (await change({ kind: "set_company_self_serve", open: false })).apply()).body.change).toMatchObject({ status: "applied" });
    expect(await h.invites.selfServeOpen()).toBe(false);
    expect((await (await change({ kind: "revoke_company_invite", codeId: made.codeId })).apply()).body.change).toMatchObject({ status: "applied" });
    expect(h.codes().find((row) => row.sk === `CODE#${made.codeHash}`)).toMatchObject({ status: "revoked" });
  });

  it("needs the administrator claim to plan or list", async () => {
    const { h, harness } = await setUp();
    const body = { requestId: "77777777-7777-4777-8777-777777777777", change: { kind: "create_company_invite", codeHash: newCompanyInviteCode().codeHash, expiresInHours: 1 }, client: { cliVersion: "0.0.7" }, methods: ["cli"] };
    expect((await harness.admin("POST", "/v1/admin/changes", { admin: false, body })).status).toBe(403);
    expect((await harness.admin("GET", "/v1/admin/company-invites", { admin: false })).body.error).toEqual({ code: "FORBIDDEN", message: "administrator claim is required" });
    expect(h.codes()).toEqual([]);
  });

  it("answers not found where the company layer is off", async () => {
    const harness = await createAdminChangeBroker();
    expect((await harness.propose({ kind: "create_company_invite", codeHash: newCompanyInviteCode().codeHash, expiresInHours: 1 }, ["cli"])).status).toBe(404);
    expect((await harness.admin("GET", "/v1/admin/company-invites")).status).toBe(404);
  });
});

describe("agentx admin company-invite", () => {
  const CHANGE = "66666666-6666-4666-8666-666666666666";
  const view = (status: string) => ({ changeId: CHANGE, kind: "create_company_invite", status, effect: "Make company invite code.", methodsOffered: ["cli"], createdAt: "2026-11-17T09:00:00.000Z", expiresAt: "2026-11-17T09:10:00.000Z", ...(status === "applied" ? { methodUsed: "cli" } : {}) });
  const deployment = { controlPlaneUrl: "http://127.0.0.1:8787", auth: { issuer: "https://identity.example.test", clientId: "agentx-client", audience: "agentx-api" } };
  async function cli(outcome: "applied" | "declined", listed?: unknown) {
    const directory = await mkdtemp(join(tmpdir(), "agentx-cli-company-invites-"));
    const deploymentFile = join(directory, "deployment.yaml");
    await writeFile(deploymentFile, JSON.stringify(deployment), "utf8");
    const tokens = new InMemoryTokenStore();
    await tokens.set(tokenStoreKey(deployment.auth), { accessToken: "access-secret-9d2e", expiresAt: Date.now() + 60_000 });
    const bodies: unknown[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname;
      if (init?.body !== undefined) bodies.push(JSON.parse(init.body as string));
      if (path === "/v1/admin/company-invites") return Response.json({ ...(listed as object), requestId: "r" });
      if (path === "/v1/admin/changes") return Response.json({ change: view("pending") });
      return Response.json({ change: view(path.endsWith("/apply") && outcome === "applied" ? "applied" : "declined") });
    }) as unknown as typeof globalThis.fetch;
    let stdout = "", stderr = "";
    const io = { fetchImplementation: fetch, tokenStore: tokens, confirm: async () => outcome === "applied", stdout: { write: (text: string) => { stdout += text; return true; } }, stderr: { write: (text: string) => { stderr += text; return true; } } };
    const run = (args: string[]) => executeCli(["--config-dir", directory, "--deployment-file", deploymentFile, "--allow-loopback", "admin", "company-invite", ...args], io);
    return { run, bodies, out: () => stdout, err: () => stderr };
  }

  it("create sends only the hash, and shows the code once, only after the change applied", async () => {
    const session = await cli("applied");
    expect(await session.run(["create", "--expires-in-hours", "48", "--yes"])).toBe(0);
    const code = new RegExp(`Invite code \\(shown once[^\\n]*\\n(${COMPANY_INVITE_CODE_PREFIX}[A-Za-z0-9_-]{32})\\n`).exec(session.err())?.[1];
    expect(code).toBeDefined();
    const sent = (session.bodies[0] as { change: unknown }).change;
    expect(sent).toEqual({ kind: "create_company_invite", codeHash: companyInviteCodeHash(code!), expiresInHours: 48 });
    expect(JSON.stringify(session.bodies)).not.toContain(code);
    expect(session.out()).toContain(companyInviteCodeId(companyInviteCodeHash(code!)));
  });

  it("a declined create never shows a code", async () => {
    const session = await cli("declined");
    await session.run(["create", "--expires-in-hours", "1"]);
    expect(session.err()).not.toContain(COMPANY_INVITE_CODE_PREFIX);
    expect(session.out()).not.toContain(COMPANY_INVITE_CODE_PREFIX);
  });

  it("refuses an expiry outside 1 to 720 hours and a malformed code id before asking anything", async () => {
    for (const args of [["create", "--expires-in-hours", "0"], ["create", "--expires-in-hours", "721"], ["create", "--expires-in-hours", "2.5"], ["revoke", "XYZ"], ["self-serve", "maybe"]]) {
      const session = await cli("applied");
      expect(await session.run(args)).not.toBe(0);
      expect(session.bodies).toEqual([]);
    }
  });

  it("list prints ids, status and the switch; revoke and self-serve send their changes", async () => {
    const session = await cli("applied", { invites: [{ codeId: "0123456789abcdef", status: "live", expiresAt: "2026-11-18T00:00:00.000Z", createdAt: "2026-11-17T00:00:00.000Z" }], more: false, selfServe: "open" });
    expect(await session.run(["list"])).toBe(0);
    expect(session.out()).toContain("Self-serve company sign-up is open.");
    expect(session.out()).toContain("0123456789abcdef  live");
    expect(await session.run(["revoke", "0123456789abcdef", "--yes"])).toBe(0);
    expect(await session.run(["self-serve", "off", "--yes"])).toBe(0);
    expect(session.bodies.map((body) => (body as { change?: unknown }).change).filter(Boolean)).toEqual([
      { kind: "revoke_company_invite", codeId: "0123456789abcdef" }, { kind: "set_company_self_serve", open: false },
    ]);
  });
});
