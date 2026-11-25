// PRIVATE-PACKAGES P1b: the company's package token, WRITTEN: `GET/PUT/DELETE /v1/app/company/package-registries` (core-host/package-registries-routes.ts, core/project-registries/company-registry-control.ts,
// token-check.ts). Every token here is a FAKE built at runtime; GitHub is a fake probe. Mutants are listed in the lane's DONE file with the test that kills each.
/* eslint-disable @typescript-eslint/no-explicit-any -- a JSON answer is read field by field */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { COMPANY_REGISTRY_AUDIT, COMPANY_REGISTRY_WORDS, CompanyRegistriesViewSchema, companyRegistrySecretName, type AuditEvent, type OrgId, type OrgRole } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { isPackageRegistriesPath, routeHostedPackageRegistries } from "../../packages/broker/src/core-host/package-registries-routes.js";
import { admitSecretName, BEING_REMOVED_MESSAGE, type ConnectionSecrets } from "../../packages/broker/src/connections/org-secrets.js";
import type { RegistrySecretStore } from "../../packages/broker/src/core/project-registries/company-registry-control.js";
import { companyRegistryEntries, companyRegistryKey, companyRegistryStore } from "../../packages/broker/src/core/project-registries/company-registry-store.js";
import { checkRegistryToken, githubScopeProbe, parseOAuthScopes, type GithubScopeAnswer } from "../../packages/broker/src/core/project-registries/token-check.js";
import { COMPANY_A, COMPANY_B } from "../support/wiki-build-fixtures.js";

const ENV = "staging";
const HOST = "npm.pkg.github.com";
const PERSON = "p1".repeat(32);
const T0 = Date.parse("2026-11-23T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
/** A fake classic token, assembled at runtime (never a literal in the source). */
const fakeToken = (tag: string): string => ["ghp", "_", tag.padEnd(36, "x")].join("");
const CANARY = fakeToken("CanaryOne");
const CANARY_TWO = fakeToken("CanaryTwo");
const token3 = (): string => fakeToken("CanaryThree");
type Body = Record<string, any>;

/** A company secret store that checks the name against the company (the real one's admit rule), keeps versions, knows secrets scheduled for deletion (7 days) and records every call. */
function fakeSecrets(now: () => number) {
  const held = new Map<string, string[]>();
  const scheduled = new Map<string, number>();
  const calls: Array<{ op: "put" | "scheduleDelete" | "read" | "restore"; company: string; name: string }> = [];
  const puts: Array<{ name: string; created: boolean; restored: boolean }> = [];
  let failWith: Error | undefined;
  const gone = (name: string): void => { const at = scheduled.get(name); if (at !== undefined && now() >= at + 7 * 24 * 60 * 60 * 1000) { held.delete(name); scheduled.delete(name); } };
  const store: ConnectionSecrets & RegistrySecretStore = {
    async read(company, name, versionId) {
      calls.push({ op: "read", company, name }); admitSecretName(ENV, company, name); gone(name);
      if (scheduled.has(name)) return undefined;
      if (versionId === undefined) return held.get(name)?.at(-1);
      const index = /^v(\d+)$/u.exec(versionId);
      return index === null ? undefined : held.get(name)?.[Number(index[1]) - 1];
    },
    async put(company, name, value) {
      calls.push({ op: "put", company, name }); admitSecretName(ENV, company, name);
      if (failWith !== undefined) throw failWith;
      const versions = held.get(name) ?? []; versions.push(value); held.set(name, versions); return `v${versions.length}`;
    },
    async putRegistryToken(company, name, value, hooks) {
      // The real adapter's rules: the company's own path (admit) and a package-token name only; an existing secret gets a new version; one scheduled for deletion is restored first.
      admitSecretName(ENV, company, name);
      if (!/\/org-connectors\/[^/]+\/pkgreg_[a-z0-9]{1,32}$/u.test(name)) throw new Error("that secret is not a company package token");
      if (failWith !== undefined) { calls.push({ op: "put", company, name }); throw failWith; }
      gone(name);
      const existed = held.has(name);
      let restored = false;
      if (scheduled.has(name)) { await hooks.beforeRestore(); calls.push({ op: "restore", company, name }); scheduled.delete(name); restored = true; }
      calls.push({ op: "put", company, name });
      const versions = held.get(name) ?? []; versions.push(value); held.set(name, versions);
      puts.push({ name, created: !existed, restored });
      return { versionId: `v${versions.length}`, created: !existed, restored };
    },
    async scheduleDelete(company, name) { calls.push({ op: "scheduleDelete", company, name }); admitSecretName(ENV, company, name); if (failWith !== undefined) throw failWith; scheduled.set(name, now()); },
  };
  return { store, held, scheduled, calls, puts, fail: (error: Error | undefined) => { failWith = error; } };
}

interface Options { probe?: (token: string) => Promise<GithubScopeAnswer>; record?: (event: AuditEvent) => Promise<void> }

function world(options: Options = {}) {
  const store = new MemoryDocumentStore();
  let clock = T0;
  const secrets = fakeSecrets(() => clock);
  const audited: AuditEvent[] = [];
  const probe = vi.fn(options.probe ?? (async () => ({ status: 200, scopes: "read:packages" })));
  const audit = { record: async (event: AuditEvent) => { if (options.record !== undefined) await options.record(event); audited.push(event); } };
  const call = async (method: string, input: { body?: unknown; raw?: string; role?: OrgRole; company?: OrgId; person?: string } = {}) => {
    const company = input.company ?? COMPANY_A;
    const answer = await routeHostedPackageRegistries({
      request: { method, path: "/v1/app/company/package-registries", headers: {}, body: input.raw ?? (input.body === undefined ? "" : JSON.stringify(input.body)) },
      path: "/v1/app/company/package-registries",
      principal: { companyId: company, personId: input.person ?? PERSON, displayName: "x", roles: [], provider: "test" }, role: input.role ?? "owner", companyId: company,
      flow: { store }, wiring: { env: ENV, secrets: secrets.store, probe }, audit, now: () => clock,
    });
    return { status: answer.statusCode, body: JSON.parse(answer.body) as Body, text: answer.body, headers: answer.headers };
  };
  const put = (token: string, extra: Record<string, unknown> = {}, who: { role?: OrgRole; company?: OrgId; person?: string } = {}) =>
    call("PUT", { body: { requestId: randomUUID(), expectedRevision: 0, host: HOST, scopes: ["@acme"], token, ...extra }, ...who });
  const del = (extra: Record<string, unknown> = {}, who: { role?: OrgRole; company?: OrgId } = {}) => call("DELETE", { body: { requestId: randomUUID(), expectedRevision: 1, host: HOST, ...extra }, ...who });
  return { store, secrets, audited, probe, call, put, del, tick: (ms: number) => { clock += ms; }, now: () => clock };
}
type World = ReturnType<typeof world>;
const errorOf = (answer: { body: Body }): { code: string; message: string } => answer.body["error"] as { code: string; message: string };
const nothingDone = async (w: World) => {
  expect(w.secrets.calls.filter((c) => c.op !== "read")).toEqual([]);
  expect(w.audited).toEqual([]);
  expect(await w.store.get(companyRegistryKey(COMPANY_A, HOST))).toBeUndefined();
};
const NAME_A = companyRegistrySecretName(ENV, COMPANY_A, HOST)!;
const NAME_B = companyRegistrySecretName(ENV, COMPANY_B, HOST)!;

describe("the path", () => {
  it("is GET, PUT and DELETE on /v1/app/company/package-registries only", () => {
    for (const method of ["GET", "PUT", "DELETE"]) expect(isPackageRegistriesPath("/v1/app/company/package-registries", method)).toBe(true);
    for (const [path, method] of [["/v1/app/company/package-registries", "POST"], ["/v1/app/company/package-registries/ghnpm", "GET"], ["/v1/app/company/package-registries/restore", "POST"], ["/v1/app/company/package-registry", "GET"], ["/v1/app/company", "GET"]] as const) {
      expect(isPackageRegistriesPath(path, method), `${method} ${path}`).toBe(false);
    }
  });
});

describe("who may write (a LIVE company owner or admin only)", () => {
  // MUTANT W1: the role check is dropped or widened (a maintainer, member, viewer or auditor saves or deletes).
  it("an owner and an admin save and delete; every other role is refused 403 in fixed words, before the body is read, the token is checked or anything is stored", async () => {
    for (const role of ["owner", "admin"] as const) {
      const w = world();
      const saved = await w.put(CANARY, {}, { role });
      expect(saved.status, role).toBe(200);
      expect((await w.del({}, { role })).status, role).toBe(200);
    }
    for (const role of ["maintainer", "member", "viewer", "billing", "auditor", "nobody"] as const) {
      const w = world();
      for (const answer of [await w.put(CANARY, {}, { role: role as OrgRole }), await w.del({}, { role: role as OrgRole }), await w.call("PUT", { raw: "{not json", role: role as OrgRole }), await w.call("DELETE", { raw: "not json", role: role as OrgRole })]) {
        expect(answer.status, role).toBe(403);
        expect(errorOf(answer), role).toEqual({ code: "FORBIDDEN", message: COMPANY_REGISTRY_WORDS.adminOnly });
        expect(answer.text).not.toContain(CANARY);
      }
      expect(w.probe).not.toHaveBeenCalled();
      await nothingDone(w);
    }
  });

  // MUTANT W2: the role is remembered (a demoted admin keeps writing) instead of read for each request.
  it("the role is the one the host read for THIS request: the same person demoted is refused on the next request", async () => {
    const w = world();
    expect((await w.put(CANARY, {}, { role: "admin" })).status).toBe(200);
    const demoted = await w.put(CANARY_TWO, { expectedRevision: 1 }, { role: "member" });
    expect(demoted.status).toBe(403);
    expect(w.secrets.held.get(NAME_A)).toEqual([CANARY]);
  });

  // MUTANT W3: the read needs the admin role (a member could not see the status line) or returns more to a member.
  it("any live member reads the status line (who and when, no value); the answer carries nothing a token could be made from", async () => {
    const w = world();
    await w.put(CANARY, { scopes: ["@acme", "@beta"] });
    for (const role of ["owner", "admin", "maintainer", "member", "viewer"] as const) {
      const got = await w.call("GET", { role: role as OrgRole });
      expect(got.status, role).toBe(200);
      const view = CompanyRegistriesViewSchema.parse(got.body);
      expect(view.registries).toEqual([{ host: HOST, state: "set", revision: 1, scopes: ["@acme", "@beta"], setAt: new Date(T0).toISOString(), setBy: PERSON }]);
      expect(got.text).not.toContain(CANARY);
      expect(got.text).not.toContain("token");
      expect(got.headers["cache-control"]).toBe("no-store");
    }
    const empty = await world().call("GET");
    expect(CompanyRegistriesViewSchema.parse(empty.body).registries).toEqual([{ host: HOST, state: "not_set", revision: 0, scopes: [] }]);
  });
});

describe("one company never touches another's", () => {
  // MUTANT C1: the company is taken from the body (or the name is built from anything but the live membership's company).
  it("the secret is named from the caller's company only; a body naming another company is refused; company B's settings and secret are its own", async () => {
    const w = world();
    for (const extra of [{ companyId: COMPANY_B }, { orgId: COMPANY_B }, { name: NAME_B }, { secretName: NAME_B }]) {
      const refused = await w.put(CANARY, extra);
      expect(refused.status).toBe(400);
      expect(errorOf(refused).message).toBe(COMPANY_REGISTRY_WORDS.bodyInvalid);
    }
    await nothingDone(w);
    expect((await w.put(CANARY)).status).toBe(200);
    expect((await w.put(CANARY_TWO, {}, { company: COMPANY_B })).status).toBe(200);
    expect(w.secrets.calls.filter((c) => c.op === "put")).toEqual([{ op: "put", company: COMPANY_A, name: NAME_A }, { op: "put", company: COMPANY_B, name: NAME_B }]);
    expect(w.secrets.held.get(NAME_A)).toEqual([CANARY]);
    expect(w.secrets.held.get(NAME_B)).toEqual([CANARY_TWO]);
    // B deletes its own; A's status and secret are untouched.
    expect((await w.del({}, { company: COMPANY_B })).status).toBe(200);
    expect(w.secrets.held.get(NAME_A)).toEqual([CANARY]);
    expect(CompanyRegistriesViewSchema.parse((await w.call("GET", { company: COMPANY_A })).body).registries[0]!.state).toBe("set");
    expect(CompanyRegistriesViewSchema.parse((await w.call("GET", { company: COMPANY_B })).body).registries[0]!.state).toBe("being_removed");
  });

  it("a row that is not exactly this company's (another orgId under this key) is unreadable: the write refuses and the entries list nothing", async () => {
    const w = world();
    await w.store.put({ item: { ...companyRegistryKey(COMPANY_A, HOST), entityType: "COMPANY_PACKAGE_REGISTRY", orgId: COMPANY_B, host: HOST, state: "set", scopes: ["@acme"], revision: 1, setAt: new Date(T0).toISOString(), setBy: PERSON } });
    const refused = await w.put(CANARY, { expectedRevision: 1 });
    expect(refused.status).toBe(503);
    expect(w.secrets.calls).toEqual([]);
    expect(await companyRegistryEntries(w.store, w.now)(COMPANY_A)).toEqual([]);
  });
});

describe("save-time validation: nothing is stored before GitHub's answer", () => {
  const withScopes = (scopes: string | undefined, status = 200) => world({ probe: async () => ({ status, scopes }) });

  // MUTANT V1: the scope check is dropped, or accepts anything that includes read:packages, or a token with repo / write / admin scopes is stored.
  it("accepts a token with read:packages, alone or beside the harmless reads read:org, read:user and user:email (each one allowed)", async () => {
    for (const header of ["read:packages", " read:packages ", "READ:PACKAGES", "read:packages, read:packages", "read:packages, read:org", "read:user, read:packages", "read:packages,user:email", "read:org, read:user, user:email, read:packages"]) {
      const w = withScopes(header);
      const answer = await w.put(CANARY);
      expect(answer.status, header).toBe(200);
      expect(answer.body["state"]).toBe("set");
      expect(w.probe).toHaveBeenCalledWith(CANARY);
      expect(w.secrets.held.get(NAME_A)).toEqual([CANARY]);
    }
  });

  it("refuses a token that holds repo, write, delete, admin, workflow or any other scope (even beside read:packages); nothing is stored, the refusal is audited with a reason code and no value", async () => {
    for (const header of ["repo", "repo, read:packages", "read:packages, write:packages", "write:packages", "delete:packages, read:packages", "admin:org, read:packages", "workflow, read:packages", "delete_repo, read:packages", "user", "read:packages, user", "read:packages, gist", "read:packages, public_repo", "read:packages, write:org", "read:packages, read:org, repo", "read:packages, some:unknown", "read:org, repo"]) {
      const w = withScopes(header);
      const answer = await w.put(CANARY);
      expect(answer.status, header).toBe(400);
      expect(errorOf(answer), header).toEqual({ code: "CONFIG_INVALID", message: COMPANY_REGISTRY_WORDS.scopesTooBroad });
      expect(answer.text).not.toContain(CANARY);
      expect(w.secrets.calls, header).toEqual([]);
      expect(await w.store.get(companyRegistryKey(COMPANY_A, HOST)), header).toBeUndefined();
      expect(w.audited.map((event) => event.action), header).toEqual([COMPANY_REGISTRY_AUDIT.refused]);
      expect(w.audited[0]!.details).toEqual({ host: HOST, reason: "scopes_too_broad", by: PERSON });
      expect(JSON.stringify(w.audited)).not.toContain(CANARY);
    }
  });

  // MUTANT V3: read:packages is not required (a token with only the harmless extras, or none, is stored).
  it("refuses a token with no read:packages (an empty or absent header, or only the harmless extras), a token GitHub does not accept, and a token it could not check", async () => {
    for (const header of ["", "  ", undefined, "read:org", "read:user, user:email", "read:org, read:user, user:email"]) {
      const w = withScopes(header);
      const answer = await w.put(CANARY);
      expect(answer.status).toBe(400);
      expect(errorOf(answer).message).toBe(COMPANY_REGISTRY_WORDS.scopesMissing);
      expect(w.secrets.calls).toEqual([]);
    }
    const rejected = withScopes("read:packages", 401);
    expect(errorOf(await rejected.put(CANARY))).toEqual({ code: "CONFIG_INVALID", message: COMPANY_REGISTRY_WORDS.tokenRejected });
    for (const w of [withScopes("read:packages", 500), withScopes("read:packages", 403), world({ probe: async () => { throw new Error(`network down for ${CANARY}`); } })]) {
      const answer = await w.put(CANARY);
      expect(answer.status).toBe(503);
      expect(errorOf(answer)).toEqual({ code: "RUNTIME_UNAVAILABLE", message: COMPANY_REGISTRY_WORDS.unchecked });
      expect(answer.text).not.toContain(CANARY);
      expect(w.secrets.calls).toEqual([]);
      expect(await w.store.get(companyRegistryKey(COMPANY_A, HOST))).toBeUndefined();
    }
  });

  // MUTANT V2: the shape check is dropped (a fine-grained token or any text reaches GitHub or the store).
  it("refuses a fine-grained token and any other shape before GitHub is asked; classic tokens only", async () => {
    const fine = ["github_pat_", "z".repeat(40)].join("");
    const w = world();
    const a = await w.put(fine);
    expect(errorOf(a)).toEqual({ code: "CONFIG_INVALID", message: COMPANY_REGISTRY_WORDS.tokenFineGrained });
    for (const bad of ["not-a-token-at-all-just-text", ["gho", "_", "y".repeat(36)].join(""), `${fakeToken("Sp")} trailing`, `${fakeToken("Nl")}\nnpm_extra=1`]) {
      const answer = await w.put(bad);
      expect(answer.status, bad).toBe(400);
      expect(errorOf(answer).message, bad).toBe(COMPANY_REGISTRY_WORDS.tokenShape);
    }
    expect(w.probe).not.toHaveBeenCalled();
    expect(w.secrets.calls).toEqual([]);
  });

  it("the live check asks api.github.com/user once with the token as a bearer, never follows a redirect, drops the body unread, and reads only x-oauth-scopes", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    let bodyRead = false;
    let bodyCancelled = false;
    const body = new ReadableStream({ pull() { bodyRead = true; }, cancel() { bodyCancelled = true; } }, { highWaterMark: 0 });
    const fake = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(body, { status: 200, headers: { "x-oauth-scopes": "read:packages" } }); }) as unknown as typeof fetch;
    const answer = await githubScopeProbe(fake)(CANARY);
    expect(answer).toEqual({ status: 200, scopes: "read:packages" });
    expect(seen!.url).toBe("https://api.github.com/user");
    expect(seen!.init.method).toBe("GET");
    expect(seen!.init.redirect).toBe("error");
    expect(seen!.init.signal).toBeDefined();
    expect((seen!.init.headers as Record<string, string>)["authorization"]).toBe(`Bearer ${CANARY}`);
    expect(bodyCancelled).toBe(true);
    expect(bodyRead).toBe(false);
    // A header that is absent is `undefined`, not an empty string.
    const none = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    expect(await githubScopeProbe(none)(CANARY)).toEqual({ status: 200, scopes: undefined });
  });

  it("parses the scopes header: lower-cased, de-duplicated, sorted; and checkRegistryToken never throws or carries the token", async () => {
    expect(parseOAuthScopes("Repo, read:packages ,, repo")).toEqual(["read:packages", "repo"]);
    const verdict = await checkRegistryToken({ host: HOST, token: CANARY, probe: async () => { throw new Error(CANARY); } });
    expect(verdict).toEqual({ ok: false, reason: "unchecked", message: COMPANY_REGISTRY_WORDS.unchecked });
    expect(JSON.stringify(verdict)).not.toContain(CANARY);
  });
});

describe("the body, the host, the revision and replays (a signed write)", () => {
  it("refuses a body that is not exactly { requestId, expectedRevision, host, scopes, token }, an unsupported host, and no scopes, with fixed words and nothing stored", async () => {
    const w = world();
    const good = { requestId: randomUUID(), expectedRevision: 0, host: HOST, scopes: ["@acme"], token: CANARY };
    const bad: Array<Record<string, unknown>> = [{ ...good, extra: 1 }, { ...good, requestId: "nope" }, { ...good, expectedRevision: "0" }, { ...good, expectedRevision: -1 }, { ...good, scopes: [] }, { ...good, scopes: ["acme"] }, { ...good, scopes: ["@a", "@a"] }, { ...good, scopes: Array.from({ length: 9 }, (_, i) => `@s${String(i)}`) }, { ...good, token: undefined }, { ...good, token: "short" }];
    for (const body of bad) {
      const answer = await w.call("PUT", { body });
      expect(answer.status).toBe(400);
      expect(errorOf(answer).message).toBe(COMPANY_REGISTRY_WORDS.bodyInvalid);
      expect(answer.text).not.toContain(CANARY);
    }
    for (const host of ["registry.npmjs.org", "NPM.PKG.GITHUB.COM", "npm.pkg.github.com.evil.example", "__proto__", "constructor"]) {
      const answer = await w.put(CANARY, { host });
      expect(answer.status, host).toBe(400);
      expect(errorOf(answer).message, host).toBe(COMPANY_REGISTRY_WORDS.hostUnsupported);
    }
    expect((await w.call("PUT", { raw: "{not json" })).status).toBe(400);
    expect(w.probe).not.toHaveBeenCalled();
    await nothingDone(w);
  });

  // MUTANT R1: the revision is not checked (a second tab overwrites a newer setting silently).
  it("a write names the revision it saw: a stale one is refused 409 (nothing written, GitHub not asked); the right one passes and the revision counts up", async () => {
    const w = world();
    expect((await w.put(CANARY)).body["revision"]).toBe(1);
    const stale = await w.put(CANARY_TWO, { expectedRevision: 0 });
    expect(stale.status).toBe(409);
    expect(errorOf(stale)).toEqual({ code: "CHANGE_STALE", message: COMPANY_REGISTRY_WORDS.stale });
    expect(w.probe).toHaveBeenCalledTimes(1);
    expect(w.secrets.held.get(NAME_A)).toEqual([CANARY]);
    expect((await w.del({ expectedRevision: 0 })).status).toBe(409);
    const replaced = await w.put(CANARY_TWO, { expectedRevision: 1 });
    expect(replaced.status).toBe(200);
    expect(replaced.body["revision"]).toBe(2);
    expect((await w.put(CANARY, { expectedRevision: 1 })).status).toBe(409);
  });

  // MUTANT R3: the row write has no fence (two saves that both read revision N both win).
  it("two saves that both read the same revision: the one that loses at the row's fence is refused 409 and its row is not written", async () => {
    const w = world();
    await w.put(CANARY);
    const real = w.store.transact.bind(w.store);
    let raced = false;
    w.store.transact = async (items) => {
      if (!raced) { raced = true; await w.store.put({ item: { ...companyRegistryKey(COMPANY_A, HOST), entityType: "COMPANY_PACKAGE_REGISTRY", orgId: COMPANY_A, host: HOST, state: "set", scopes: ["@other"], revision: 2, setAt: new Date(T0).toISOString(), setBy: "someone-else" } }); }
      return real(items);
    };
    const lost = await w.put(CANARY_TWO, { expectedRevision: 1 });
    expect(lost.status).toBe(409);
    expect(errorOf(lost).message).toBe(COMPANY_REGISTRY_WORDS.stale);
    expect(await w.store.get(companyRegistryKey(COMPANY_A, HOST))).toMatchObject({ setBy: "someone-else", revision: 2 });
  });

  // MUTANT R2: a replay writes again (a second audit row, a second secret version).
  it("the same requestId answers the status it already made, and writes, checks and records nothing more", async () => {
    const w = world();
    const requestId = randomUUID();
    const first = await w.put(CANARY, { requestId });
    const second = await w.put(CANARY, { requestId, expectedRevision: 0 });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(w.probe).toHaveBeenCalledTimes(1);
    expect(w.secrets.calls.filter((c) => c.op === "put")).toHaveLength(1);
    expect(w.audited).toHaveLength(1);
  });
});

describe("set, replace, delete: the secret and the audit rows", () => {
  // MUTANT S1: replace creates a second secret, or keeps the old value; the name differs from the reader's.
  it("a save writes the secret under exactly the name the exchange reads; a second save is a new version of it (the row says replaced); the token is stored as the whole value", async () => {
    const w = world();
    const first = await w.put(CANARY);
    expect(first.body).toEqual({ host: HOST, state: "set", revision: 1, scopes: ["@acme"], setAt: new Date(T0).toISOString(), setBy: PERSON });
    w.tick(1_000);
    const second = await w.put(CANARY_TWO, { expectedRevision: 1, scopes: ["@beta", "@acme"] });
    expect(second.body).toMatchObject({ state: "set", revision: 2, scopes: ["@acme", "@beta"], setAt: new Date(T0 + 1_000).toISOString() });
    expect(w.secrets.calls.map((c) => [c.op, c.name])).toEqual([["put", NAME_A], ["put", NAME_A]]);
    expect(w.secrets.held.get(NAME_A)).toEqual([CANARY, CANARY_TWO]);
    // The exchange's own reader sees the newest version, through the same store the routes wrote (the one reader).
    const reader = companyRegistryStore({ env: ENV, store: w.store, secrets: w.secrets.store, now: w.now });
    expect(await reader.token(COMPANY_A, HOST)).toEqual({ token: CANARY_TWO });
    expect(await reader.entries(COMPANY_A)).toEqual([{ host: HOST, scopes: ["@acme", "@beta"] }]);
    expect(await reader.entries(COMPANY_B)).toEqual([]);
    expect(await reader.token(COMPANY_B, HOST)).toBeUndefined();
    // MUTANT S2: a replace keeps the first person's name on the row (the status line must say who set the token that is in force).
    const third = await w.put(token3(), { expectedRevision: 2 }, { person: "another-admin", role: "admin" });
    expect(third.body).toMatchObject({ setBy: "another-admin", revision: 3 });
  });

  // MUTANT A1: an audit row is missing, carries the value, or does not say who and when.
  it("audit rows (set, replace, delete) say who, when, host and scopes, and NEVER the value; they are recorded before the secret changes", async () => {
    const order: string[] = [];
    const w = world({ record: async (event) => { order.push(`audit:${event.action}`); } });
    const original = w.secrets.store.putRegistryToken.bind(w.secrets.store);
    w.secrets.store.putRegistryToken = async (...args) => { order.push("secret:put"); return original(...args); };
    await w.put(CANARY);
    w.tick(60_000);
    await w.put(CANARY_TWO, { expectedRevision: 1 });
    w.tick(60_000);
    await w.del({ expectedRevision: 2 });
    expect(w.audited.map((event) => event.action)).toEqual([COMPANY_REGISTRY_AUDIT.set, COMPANY_REGISTRY_AUDIT.replace, COMPANY_REGISTRY_AUDIT.delete]);
    expect(order).toEqual(["audit:package_registry.token_set", "secret:put", "audit:package_registry.token_replaced", "secret:put", "audit:package_registry.token_deleted"]);
    for (const event of w.audited) {
      expect(event.companyId).toBe(COMPANY_A);
      expect(event.actor).toEqual({ type: "person", id: PERSON });
      expect(event.subject).toEqual({ type: "company", id: COMPANY_A });
      expect(event.details).toMatchObject({ host: HOST, scopes: ["@acme"], by: PERSON, role: "owner" });
      expect(Date.parse(event.at)).toBeGreaterThanOrEqual(T0);
    }
    expect(w.audited.map((event) => event.at)).toEqual([new Date(T0).toISOString(), new Date(T0 + 60_000).toISOString(), new Date(T0 + 120_000).toISOString()]);
    const text = JSON.stringify(w.audited);
    for (const canary of [CANARY, CANARY_TWO, "ghp_"]) expect(text).not.toContain(canary);
    expect(text).not.toMatch(/token"|"token|secretVersion/u);
    expect(new Set(w.audited.map((event) => event.eventId)).size).toBe(3);
  });

  it("an audit record that cannot be written stops the act: no secret, no row, 503 in fixed words", async () => {
    const w = world({ record: async () => { throw new Error(`audit store down ${CANARY}`); } });
    const answer = await w.put(CANARY);
    expect(answer.status).toBe(503);
    expect(errorOf(answer)).toEqual({ code: "AUDIT_UNAVAILABLE", message: COMPANY_REGISTRY_WORDS.auditUnavailable });
    expect(answer.text).not.toContain(CANARY);
    expect(w.secrets.calls).toEqual([]);
    expect(await w.store.get(companyRegistryKey(COMPANY_A, HOST))).toBeUndefined();
  });

  // MUTANT D1: delete forgets the recovery window (the secret is gone at once, or the row says it is).
  it("a delete schedules the secret's deletion (the adapter keeps the 7 day window) and the row says being_removed until the window is over; the entries list nothing meanwhile", async () => {
    const w = world();
    await w.put(CANARY);
    w.tick(1_000);
    const removed = await w.del({ expectedRevision: 1 });
    expect(removed.body).toEqual({ host: HOST, state: "being_removed", revision: 2, scopes: ["@acme"], setAt: new Date(T0).toISOString(), setBy: PERSON, removedAt: new Date(T0 + 1_000).toISOString() });
    expect(w.secrets.calls.filter((c) => c.op === "scheduleDelete")).toEqual([{ op: "scheduleDelete", company: COMPANY_A, name: NAME_A }]);
    const reader = companyRegistryStore({ env: ENV, store: w.store, secrets: w.secrets.store, now: w.now });
    expect(await reader.entries(COMPANY_A)).toEqual([]);
    w.tick(6 * DAY);
    expect((await w.del({ expectedRevision: 2 })).status).toBe(404);
    expect(CompanyRegistriesViewSchema.parse((await w.call("GET")).body).registries[0]!.state).toBe("being_removed");
    w.tick(DAY + 2_000);
    expect(CompanyRegistriesViewSchema.parse((await w.call("GET")).body).registries[0]).toEqual({ host: HOST, state: "not_set", revision: 2, scopes: [] });
    // The window is over: the secret is gone, so the next save creates it (nothing to restore).
    const again = await w.put(CANARY_TWO, { expectedRevision: 2 });
    expect(again.status).toBe(200);
    expect(again.body["revision"]).toBe(3);
    expect(w.secrets.puts.at(-1)).toEqual({ name: NAME_A, created: true, restored: false });
  });

  // MUTANT A1: a re-save during the removal window is refused for 7 days (or restores nothing / writes a second secret).
  it("a save during the removal window is NOT blocked: the secret scheduled for deletion is restored (audited BEFORE the restore: who, when, host), a new version is written into it, and the row points at that version", async () => {
    const order: string[] = [];
    const w = world({ record: async (event) => { order.push(`audit:${event.action}`); } });
    await w.put(CANARY);
    await w.del({ expectedRevision: 1 });
    w.tick(2 * DAY);
    order.length = 0;
    const original = w.secrets.store.putRegistryToken.bind(w.secrets.store);
    w.secrets.store.putRegistryToken = async (...args) => { order.push("secret:put-registry"); return original(...args); };
    const saved = await w.put(CANARY_TWO, { expectedRevision: 2 });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ state: "set", revision: 3 });
    expect(saved.body).not.toHaveProperty("removedAt");
    expect(w.secrets.calls.map((c) => c.op).slice(-3)).toEqual(["scheduleDelete", "restore", "put"]);
    expect(w.secrets.puts.at(-1)).toEqual({ name: NAME_A, created: false, restored: true });
    expect(w.secrets.held.get(NAME_A)).toEqual([CANARY, CANARY_TWO]);
    expect(w.secrets.scheduled.has(NAME_A)).toBe(false);
    // The row points at the new version, and the reader serves exactly that.
    expect(await w.store.get(companyRegistryKey(COMPANY_A, HOST))).toMatchObject({ state: "set", secretVersionId: "v2" });
    expect(await companyRegistryStore({ env: ENV, store: w.store, secrets: w.secrets.store, now: w.now }).token(COMPANY_A, HOST)).toEqual({ token: CANARY_TWO });
    // The restore is audited before it happens, and the adoption after; none of it carries the value.
    expect(order).toEqual(["audit:package_registry.token_set", "secret:put-registry", "audit:package_registry.secret_restored", "audit:package_registry.secret_adopted"]);
    const restored = w.audited.find((event) => event.action === COMPANY_REGISTRY_AUDIT.restored)!;
    expect(restored.details).toEqual({ host: HOST, by: PERSON, role: "owner" });
    expect(restored.actor).toEqual({ type: "person", id: PERSON });
    expect(Date.parse(restored.at)).toBe(T0 + 2 * DAY);
    expect(w.audited.map((event) => event.action)).toContain(COMPANY_REGISTRY_AUDIT.adopted);
    expect(JSON.stringify(w.audited)).not.toContain(CANARY_TWO);
  });

  // MUTANT A2: the restore is not audited first (or an audit that fails does not stop the restore).
  it("a restore whose audit record cannot be written does not happen: nothing restored, no new version, the row unchanged", async () => {
    const w = world({ record: async (event) => { if (event.action === COMPANY_REGISTRY_AUDIT.restored) throw new Error("audit down"); } });
    await w.put(CANARY);
    await w.del({ expectedRevision: 1 });
    const refused = await w.put(CANARY_TWO, { expectedRevision: 2 });
    expect(refused.status).toBe(503);
    expect(errorOf(refused)).toEqual({ code: "AUDIT_UNAVAILABLE", message: COMPANY_REGISTRY_WORDS.auditUnavailable });
    expect(w.secrets.calls.filter((c) => c.op === "restore")).toEqual([]);
    expect(w.secrets.held.get(NAME_A)).toEqual([CANARY]);
    expect(w.secrets.scheduled.has(NAME_A)).toBe(true);
    expect(await w.store.get(companyRegistryKey(COMPANY_A, HOST))).toMatchObject({ state: "being_removed", revision: 2 });
  });

  it("a delete with nothing set is 404 in fixed words; a secret store that refuses or reports a removal in progress changes nothing and says fixed words only", async () => {
    const w = world();
    const none = await w.del({ expectedRevision: 0 });
    expect(none.status).toBe(404);
    expect(errorOf(none).message).toBe(COMPANY_REGISTRY_WORDS.notSet);
    await w.put(CANARY);
    w.secrets.fail(new Error(`AccessDenied for arn:aws:secretsmanager:${NAME_A} ${CANARY}`));
    for (const answer of [await w.put(CANARY_TWO, { expectedRevision: 1 }), await w.del({ expectedRevision: 1 })]) {
      expect(answer.status).toBe(503);
      expect(errorOf(answer)).toEqual({ code: "RUNTIME_UNAVAILABLE", message: COMPANY_REGISTRY_WORDS.unavailable });
      expect(answer.text).not.toContain(CANARY);
      expect(answer.text).not.toContain("arn:");
    }
    w.secrets.fail(new Error(BEING_REMOVED_MESSAGE));
    const removing = await w.put(CANARY_TWO, { expectedRevision: 1 });
    expect(errorOf(removing).message).toBe(COMPANY_REGISTRY_WORDS.beingRemoved);
    // The row did not move: still the first save.
    expect(((await w.call("GET")).body["registries"] as unknown[])[0]).toMatchObject({ state: "set", revision: 1 });
  });
});

describe("the row is the one source of truth for the token in force (review F1) and a first save never leaves a secret with no row", () => {
  // MUTANT F1: the reader serves the CURRENT secret version instead of the version the row names.
  it("the exchange's reader serves the version the settings row names: a version a losing save wrote last is never served, and a secret with no row or a removed row is not served at all", async () => {
    const w = world();
    const reader = companyRegistryStore({ env: ENV, store: w.store, secrets: w.secrets.store, now: w.now });
    expect(await reader.token(COMPANY_A, HOST)).toBeUndefined();
    await w.put(CANARY);
    // A second admin's save that lost the row's fence still wrote its secret version last (it is AWSCURRENT).
    w.secrets.held.get(NAME_A)!.push(CANARY_TWO);
    expect(await w.secrets.store.read(COMPANY_A, NAME_A)).toBe(CANARY_TWO);
    expect(await reader.token(COMPANY_A, HOST)).toEqual({ token: CANARY });
    // No row: the secret alone is nothing.
    const other = world();
    other.secrets.held.set(NAME_A, [CANARY]);
    expect(await companyRegistryStore({ env: ENV, store: other.store, secrets: other.secrets.store, now: other.now }).token(COMPANY_A, HOST)).toBeUndefined();
    // Removed: not served, even though the secret waits out its window.
    await w.del({ expectedRevision: 1 });
    w.secrets.held.set(NAME_A, [CANARY]);
    expect(await reader.token(COMPANY_A, HOST)).toBeUndefined();
  });

  const failingRowWrite = (w: World) => {
    const real = w.store.transact.bind(w.store);
    w.store.transact = async () => { throw new Error(`store down ${CANARY}`); };
    return () => { w.store.transact = real; };
  };

  // MUTANT F2: a first save whose row never landed is not adopted by the next save (a second secret is created, a create is attempted, or the save is blocked).
  it("a FIRST save whose row cannot be written leaves its secret; the next save ADOPTS it: no new create, a new version, and the row points at that version (no delete, nothing blocked)", async () => {
    const w = world();
    const restoreRowWrite = failingRowWrite(w);
    const failed = await w.put(CANARY);
    expect(failed.status).toBe(503);
    expect(errorOf(failed)).toEqual({ code: "RUNTIME_UNAVAILABLE", message: COMPANY_REGISTRY_WORDS.unavailable });
    expect(failed.text).not.toContain(CANARY);
    // The orphan: a secret with no row. Nothing is deleted and nothing lists it.
    expect(w.secrets.calls.map((c) => c.op)).toEqual(["put"]);
    expect(w.secrets.held.get(NAME_A)).toEqual([CANARY]);
    expect(await w.store.get(companyRegistryKey(COMPANY_A, HOST))).toBeUndefined();
    expect(await companyRegistryEntries(w.store, w.now)(COMPANY_A)).toEqual([]);
    restoreRowWrite();
    const again = await w.put(CANARY_TWO);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ state: "set", revision: 1 });
    expect(w.secrets.puts).toEqual([{ name: NAME_A, created: true, restored: false }, { name: NAME_A, created: false, restored: false }]);
    expect(w.secrets.held.get(NAME_A)).toEqual([CANARY, CANARY_TWO]);
    expect(w.secrets.calls.some((c) => c.op === "scheduleDelete" || c.op === "restore")).toBe(false);
    expect(await w.store.get(companyRegistryKey(COMPANY_A, HOST))).toMatchObject({ state: "set", secretVersionId: "v2" });
    expect(await companyRegistryStore({ env: ENV, store: w.store, secrets: w.secrets.store, now: w.now }).token(COMPANY_A, HOST)).toEqual({ token: CANARY_TWO });
    // The adoption is audited (who, host; no value).
    const adopted = w.audited.find((event) => event.action === COMPANY_REGISTRY_AUDIT.adopted)!;
    expect(adopted.details).toEqual({ host: HOST, by: PERSON, role: "owner" });
    expect(JSON.stringify(w.audited)).not.toContain(CANARY);
  });

  // MUTANT F3: an orphan that is scheduled for deletion is not restored (the save is refused), or is restored without being adopted.
  it("an orphan SCHEDULED FOR DELETION (no row) is restored first and then adopted", async () => {
    const w = world();
    w.secrets.held.set(NAME_A, [CANARY]);
    w.secrets.scheduled.set(NAME_A, T0 - DAY);
    const saved = await w.put(CANARY_TWO);
    expect(saved.status).toBe(200);
    expect(w.secrets.calls.map((c) => c.op)).toEqual(["restore", "put"]);
    expect(w.secrets.puts).toEqual([{ name: NAME_A, created: false, restored: true }]);
    expect(w.audited.map((event) => event.action)).toEqual([COMPANY_REGISTRY_AUDIT.set, COMPANY_REGISTRY_AUDIT.restored, COMPANY_REGISTRY_AUDIT.adopted]);
    expect(await w.store.get(companyRegistryKey(COMPANY_A, HOST))).toMatchObject({ state: "set", secretVersionId: "v2" });
  });

  // MUTANT F4: the adoption reaches another company's secret.
  it("an orphan of ANOTHER company is never touched: a save for company A names company A's secret only, and the other company's secret keeps its versions and its scheduled deletion", async () => {
    const w = world();
    w.secrets.held.set(NAME_B, [CANARY]);
    w.secrets.scheduled.set(NAME_B, T0 - DAY);
    const saved = await w.put(CANARY_TWO);
    expect(saved.status).toBe(200);
    expect(w.secrets.puts).toEqual([{ name: NAME_A, created: true, restored: false }]);
    expect(w.secrets.calls.filter((c) => c.name === NAME_B)).toEqual([]);
    expect(w.secrets.held.get(NAME_B)).toEqual([CANARY]);
    expect(w.secrets.scheduled.has(NAME_B)).toBe(true);
    // And the store itself refuses any name that is not this company's own package token: another company's, another leaf, another family.
    for (const name of [NAME_B, `agentx/${ENV}/org-connectors/${COMPANY_A}/conn-1`, `agentx/${ENV}/org-hooks/${COMPANY_A}/pkgreg_ghnpm`]) {
      await expect(w.secrets.store.putRegistryToken(COMPANY_A, name, CANARY, { beforeRestore: async () => undefined }), name).rejects.toThrow();
    }
    expect(w.secrets.held.get(NAME_B)).toEqual([CANARY]);
  });

  it("a replace never audits an adoption (the row's own version is in force), and a save that lost the row's fence to another writer leaves its version unreferenced: the reader serves the row's", async () => {
    const replace = world();
    await replace.put(CANARY);
    await replace.put(CANARY_TWO, { expectedRevision: 1 });
    expect(replace.audited.map((event) => event.action)).toEqual([COMPANY_REGISTRY_AUDIT.set, COMPANY_REGISTRY_AUDIT.replace]);

    const raced = world();
    const real = raced.store.transact.bind(raced.store);
    raced.store.transact = async (items) => {
      await raced.store.put({ item: { ...companyRegistryKey(COMPANY_A, HOST), entityType: "COMPANY_PACKAGE_REGISTRY", orgId: COMPANY_A, host: HOST, state: "set", scopes: ["@other"], revision: 1, setAt: new Date(T0).toISOString(), setBy: "someone-else", secretVersionId: "v1" } });
      return real(items);
    };
    raced.secrets.held.set(NAME_A, [CANARY]);
    expect((await raced.put(CANARY_TWO)).status).toBe(409);
    expect(raced.secrets.calls.some((c) => c.op === "scheduleDelete")).toBe(false);
    expect(await companyRegistryStore({ env: ENV, store: raced.store, secrets: raced.secrets.store, now: raced.now }).token(COMPANY_A, HOST)).toEqual({ token: CANARY });
  });
});

describe("no route returns the value", () => {
  // MUTANT N1: any answer (success, refusal, error, GET after a save) carries the token or a fragment of it.
  it("every answer of every method, success or refusal, lacks the token and every piece of it; a GET after a save names only the status line", async () => {
    const w = world();
    const answers = [
      await w.put(CANARY), await w.call("GET"), await w.put(CANARY_TWO, { expectedRevision: 1, scopes: ["@x"] }), await w.call("GET", { role: "member" }),
      await w.put(CANARY, {}, { role: "member" }), await w.put(CANARY, { host: "example.com" }), await w.put(CANARY, { expectedRevision: 9 }), await w.del({ expectedRevision: 2 }), await w.call("GET"),
      await w.call("PUT", { raw: `{"token":"${CANARY}",` }),
    ];
    for (const answer of answers) {
      for (const piece of [CANARY, CANARY_TWO, CANARY.slice(4, 24), CANARY_TWO.slice(10, 30)]) expect(answer.text).not.toContain(piece);
      expect(Object.keys(answer.body).filter((key) => /token|secret|value|password/iu.test(key))).toEqual([]);
    }
    expect(answers.at(-1)!.status).toBe(400);
  });

  it("the stored settings row holds no token, length, hash or fragment of one", async () => {
    const w = world();
    await w.put(CANARY);
    const row = JSON.stringify(await w.store.get(companyRegistryKey(COMPANY_A, HOST)));
    expect(row).not.toContain("ghp");
    expect(row).not.toContain(CANARY.slice(4, 24));
    expect(Object.keys(JSON.parse(row) as Record<string, unknown>).sort()).toEqual(["entityType", "host", "orgId", "pk", "requestId", "revision", "scopes", "secretVersionId", "setAt", "setBy", "sk", "state"]);
  });

  it("nothing logs: a console, stdout or stderr write during a save, a refusal or an error never holds the token or the request body", async () => {
    const lines: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((name) => vi.spyOn(console, name).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); }));
    const out = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => { lines.push(String(chunk)); return true; }));
    const err = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => { lines.push(String(chunk)); return true; }));
    try {
      const w = world({ probe: async () => ({ status: 200, scopes: "repo" }) });
      await w.put(CANARY);
      const ok = world();
      await ok.put(CANARY);
      await ok.del({ expectedRevision: 1 });
      ok.secrets.fail(new Error(CANARY));
      await ok.put(CANARY_TWO, { expectedRevision: 2 });
    } finally { for (const spy of [...spies, out, err]) spy.mockRestore(); }
    expect(lines.join("\n")).not.toContain("ghp_");
  });

  // MUTANT N2: a second reader of a company token appears (a route, a tool or a core function reads it back).
  it("the write side never reads a token: the secret store it is handed has no read it calls, and the census shows ONE reader of a stored token (company-token-reader.ts), built in one place", async () => {
    const w = world();
    await w.put(CANARY);
    await w.del({ expectedRevision: 1 });
    expect(w.secrets.calls.filter((c) => c.op === "read")).toEqual([]);
    const root = join(__dirname, "../../packages");
    const files: string[] = [];
    const walk = (dir: string): void => { for (const name of readdirSync(dir)) { if (name === "node_modules" || name === "dist") continue; const full = join(dir, name); if (statSync(full).isDirectory()) walk(full); else if (name.endsWith(".ts")) files.push(full); } };
    for (const pkg of ["broker", "aws-adapters", "worker", "cli"]) walk(join(root, pkg, "src"));
    const textOf = (file: string): string => readFileSync(file, "utf8");
    const where = (pattern: RegExp): string[] => files.filter((file) => pattern.test(textOf(file))).map((file) => file.slice(root.length + 1)).sort();
    // ONE-READER CENSUS (Opus review of P1a): the stored token is read in exactly one place, company-token-reader.ts, and that reader is built in exactly one place (the company store the exchange uses).
    expect(where(/companyRegistryTokenReader\(/u)).toEqual(["broker/src/core/project-registries/company-registry-store.ts", "broker/src/core/project-registries/company-token-reader.ts"]);
    expect(where(/\.read\(\s*\w+,\s*name\b/u).filter((file) => /project-registries/u.test(file))).toEqual(["broker/src/core/project-registries/company-token-reader.ts"]);
    // The name of a company's package token is built (companyRegistrySecretName) only by the reader and the write control; nothing else names a pkgreg_ secret.
    expect(where(/companyRegistrySecretName\(/u)).toEqual(["broker/src/core/project-registries/company-registry-control.ts", "broker/src/core/project-registries/company-token-reader.ts"]);
    expect(where(/pkgreg_/u)).toEqual(["aws-adapters/src/secrets-manager/company-names.ts", "aws-adapters/src/secrets-manager/connection-secrets.ts", "broker/src/core/project-registries/company-token-reader.ts"]);
    // No file reads a secret's value from Secrets Manager except the adapters' own stores; no broker file outside the generic stores names GetSecretValue near a registry or company-token path.
    expect(where(/GetSecretValueCommand/u).filter((file) => /project-registries|package-registries|company-registry/u.test(file))).toEqual([]);
    // The write modules never read a secret at all.
    for (const file of ["broker/src/core-host/package-registries-routes.ts", "broker/src/core/project-registries/company-registry-control.ts", "broker/src/core/project-registries/company-registry-store.ts", "broker/src/core/project-registries/token-check.ts"]) {
      const source = textOf(join(root, file));
      if (file.endsWith("company-registry-store.ts")) expect(source.match(/\.read\(/gu) ?? [], file).toEqual([]);
      else expect(source, file).not.toMatch(/\.read\(|GetSecretValue|getSecret/u);
    }
    // And the route table of the install has no other row on this path than the three.
    const routeTable = textOf(join(root, "code-api/src/routes.ts"));
    expect(routeTable.match(/path: "\/v1\/app\/company\/package-registries[^"]*"/gu)).toEqual(Array(3).fill('path: "/v1/app/company/package-registries"'));
  });
});
