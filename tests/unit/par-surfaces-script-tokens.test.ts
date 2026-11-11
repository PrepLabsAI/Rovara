// script tokens on `rovara up`. A running install (memory storage, simulated Docker) is driven over HTTP the way a script and the owner's browser would drive it: the
// owner makes a token on a local page (a form, a page session opened a few minutes ago), a script uses it on the closed list of task routes, and everything else is refused with one fixed text.
// The token is stored only as a hash, shown once, scoped to projects and permissions, revocable at once, expiring, rate limited and audited, and it is never an approval.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateScriptTokenBodySchema, CreatedScriptTokenSchema, IMPLICIT_COMPANY_ID, SCRIPT_TOKEN_NOT_ALLOWED_MESSAGE, SCRIPT_TOKEN_PERMISSIONS, SCRIPT_TOKENS_PER_PERSON_MAX, ScriptTokenListSchema, WORKER_INVOCATION_FEATURES, orgScriptTokensKey, scriptTokenKey,
  type AuditEvent, type AuditSink,
} from "@agentx/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scriptTokenRoute } from "../../packages/broker/src/core/script-tokens/authenticate.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createScriptToken, listScriptTokens, noteScriptTokenUse, readScriptToken, revokeScriptToken, ScriptTokenRecordSchema, type ScriptTokenDependencies } from "../../packages/broker/src/core/script-tokens/store.js";
import { hashScriptToken, isScriptTokenHeader, mintScriptToken, parseScriptTokenHeader, scriptTokenMatches } from "../../packages/broker/src/core/script-tokens/token-format.js";
import { scriptTokensEnabled } from "../../packages/broker/src/core/script-tokens/switch.js";
import { takeRate } from "../../packages/broker/src/core/script-tokens/rate.js";
import { FakeWorkerMachines } from "../../packages/broker/src/ports/fake-worker-machines.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { LocalPageSessions, MAX_SESSIONS } from "../../packages/broker/src/core/local-pages/guard.js";
import { startLocalRuntime, type LocalRuntime } from "../../packages/broker/src/local/runtime.js";
import { FakeDocker } from "../support/local/fake-docker.js";
import { formBody, formOf, raw } from "../support/local-pages-fakes.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  while (cleanup.length > 0) await cleanup.pop()!();
});

const project = (name: string) => ({
  name, revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://examplehost/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
});
/** A token id, built at runtime (the public repository refuses key-shaped strings in a file). */
const SOME_TOKEN_ID = ["stk", "abcdefghij0123456789"].join("_");
const REQUEST = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;

interface TaskBody { taskId: string; client: string; project: string; workflow: { decisions: unknown[] }; closing?: boolean }
/** What the routes answer, as far as these tests read it. */
interface Json { task: TaskBody; tasks: TaskBody[]; tokens: unknown[]; projects: Array<{ name: string }>; token: { tokenId: string; status: string }; error: { code: string; message: string } }

async function launch(extra: { environment?: NodeJS.ProcessEnv; storage?: "sqlite" | "memory"; root?: string } = {}) {
  const root = extra.root ?? await mkdtemp(join(tmpdir(), "rovara-surfaces-"));
  if (extra.root === undefined) cleanup.push(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const events: AuditEvent[] = [];
  const audit: AuditSink = {
    stage(event) { events.push(event); return [{ kind: "put", item: { pk: `AUDIT#${event.companyId}`, sk: `EVENT#${event.eventId}`, entityType: "AUDIT", action: event.action, at: event.at }, condition: { op: "notExists", path: ["pk"] } }]; },
    async record(event) { events.push(event); },
  };
  const opened: string[] = [];
  const runtime: LocalRuntime = await startLocalRuntime({
    stateDirectory, cwd: join(root, "project"), environment: extra.environment ?? {}, gh: async () => undefined, workerImage: "worker:test", docker: new FakeDocker(), version: "9.9.9",
    machines: new FakeWorkerMachines({ startingChecks: 0, features: [...WORKER_INVOCATION_FEATURES] }), timers: false, storage: extra.storage ?? "memory",
    registerAdapters: (registry) => { registry.register("audit-sink", "recording", audit); }, openBrowser: async (url) => { opened.push(url); },
  });
  cleanup.push(() => runtime.stop());
  const sessionToken = (await readFile(runtime.sessionTokenPath, "utf8")).trim();
  const call = async (token: string, path: string, init: { method?: string; body?: unknown } = {}) => {
    const response = await fetch(`${runtime.url}${path}`, {
      method: init.method ?? "GET", headers: { authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as Json };
  };
  const api = (path: string, init?: { method?: string; body?: unknown }) => call(sessionToken, path, init);
  /** The owner's "open in browser": the page address the browser lands on (the recorder follows the single-use address once). */
  const browse = async (path: string, fresh = false): Promise<{ base: string; host: string }> => {
    const answer = await api("/v1/local/pages/open", { method: "POST", body: { path, ...(fresh ? { fresh: true } : {}) } });
    expect(answer.status).toBe(200);
    const once = new URL(opened.at(-1)!);
    const hop = await raw(runtime.pagesUrl, { path: once.pathname, headers: { host: once.host } });
    expect(hop.status).toBe(303);
    const location = new URL(hop.headers["location"] as string, runtime.pagesUrl);
    return { base: location.pathname.split("/").slice(0, 3).join("/"), host: location.host };
  };
  const page = (where: { base: string; host: string }, path: string) => raw(runtime.pagesUrl, { path: `${where.base}${path}`, headers: { host: where.host } });
  const post = (where: { base: string; host: string }, path: string, fields: Record<string, string> | URLSearchParams) => raw(runtime.pagesUrl, {
    method: "POST", path: `${where.base}${path}`, body: fields instanceof URLSearchParams ? fields.toString() : formBody(fields),
    headers: { host: where.host, origin: runtime.pagesUrl, "content-type": "application/x-www-form-urlencoded" },
  });
  /** Makes a token on the page, as the owner does. Returns the secret the answer showed. */
  const makeToken = async (input: { name?: string; projects?: string[]; permissions?: string[]; days?: string } = {}): Promise<{ secret: string; where: { base: string; host: string }; html: string }> => {
    const where = await browse("/tokens", true);
    const drawn = await page(where, "/tokens");
    expect(drawn.status).toBe(200);
    const form = formOf(drawn.body, "/tokens/create");
    const fields = new URLSearchParams(form.fields);
    fields.set("name", input.name ?? "CI deploy");
    for (const name of input.projects ?? ["payments"]) fields.append("project", name);
    for (const permission of input.permissions ?? ["read", "start"]) fields.append("permission", permission);
    if (input.days !== undefined) fields.set("days", input.days);
    const made = await post(where, "/tokens/create", fields);
    expect(made.status, made.body).toBe(200);
    const secret = /<code>(rvst_[0-9a-z]{20}_[0-9a-z]{20}_[A-Za-z0-9_-]{43})<\/code>/.exec(made.body)?.[1];
    expect(secret, made.body).toBeDefined();
    return { secret: secret!, where, html: made.body };
  };
  await api("/v1/admin/projects", { method: "POST", body: project("payments") });
  await api("/v1/admin/projects", { method: "POST", body: project("billing") });
  return { root, runtime, events, api, call, browse, page, post, makeToken, sessionToken, store: runtime.registry.require("storage") };
}

const start = (h: Awaited<ReturnType<typeof launch>>, secret: string, n: number, name = "payments") => h.call(secret, "/v1/dev/tasks", { method: "POST", body: { requestId: REQUEST(n), project: name, instructions: "Fix the retry bug", workflow: true, client: "pretend-to-be-claude-code" } });

describe("the token format and the closed list", () => {
  it("makes a token that parses, matches only its own hash and shows only an id hint", () => {
    const { token, hash } = mintScriptToken(IMPLICIT_COMPANY_ID, SOME_TOKEN_ID);
    expect(token).toMatch(/^rvst_[0-9a-z]{20}_[0-9a-z]{20}_[A-Za-z0-9_-]{43}$/);
    expect(hash).toBe(hashScriptToken(token));
    expect(scriptTokenMatches(token, hash)).toBe(true);
    expect(scriptTokenMatches(`${token}x`, hash)).toBe(false);
    expect(scriptTokenMatches(token, "not a hash")).toBe(false);
    expect(scriptTokenMatches(token, undefined)).toBe(false);
    expect(parseScriptTokenHeader(`Bearer ${token}`)).toMatchObject({ orgId: IMPLICIT_COMPANY_ID, tokenId: SOME_TOKEN_ID, token });
    expect(parseScriptTokenHeader(`Bearer ${token}x`)).toBeUndefined();
    expect(parseScriptTokenHeader("Bearer abc")).toBeUndefined();
    expect(parseScriptTokenHeader(`Bearer rvst_${"a".repeat(400)}`)).toBeUndefined();
    expect(isScriptTokenHeader(`Bearer ${token}`)).toBe(true);
    expect(isScriptTokenHeader("Bearer something-else")).toBe(false);
  });

  it("allows exactly the task reads and the task start, and nothing else", () => {
    const task = "0b4f2b1e-3c6a-4d2e-9a77-5f1d8c0a1e11";
    expect(scriptTokenRoute("POST", "/v1/dev/tasks")).toEqual({ permission: "start", project: "body" });
    expect(scriptTokenRoute("GET", "/v1/dev/tasks")).toEqual({ permission: "read", project: "query" });
    expect(scriptTokenRoute("GET", `/v1/dev/tasks/${task}`)).toEqual({ permission: "read", project: "task", taskId: task });
    expect(scriptTokenRoute("GET", `/v1/dev/tasks/${task}/events`)).toEqual({ permission: "read", project: "task", taskId: task });
    for (const [method, path] of [
      ["POST", `/v1/dev/tasks/${task}/workflow/decision`], ["POST", `/v1/dev/tasks/${task}/close`], ["POST", `/v1/dev/tasks/${task}/cancel`], ["POST", `/v1/dev/tasks/${task}/continue`],
      ["GET", `/v1/dev/tasks/${task}/plan`], ["POST", `/v1/dev/tasks/${task}/workflow/retry`], ["GET", "/v1/dev/projects"], ["POST", "/v1/admin/projects"], ["GET", "/v1/app/sessions"],
      ["POST", "/v1/local/pages/open"], ["GET", "/v1/local/status"], ["GET", "/v1/app/script-tokens"], ["POST", "/v1/app/script-tokens"], ["POST", "/v1/app/script-tokens/stk_x/revoke"], ["DELETE", "/v1/dev/tasks"],
      ["GET", `/v1/dev/tasks/${task}/../projects`], ["GET", `/v1/dev/tasks/${task}/x`], ["GET", "/v1/internal/model-access"],
    ] as const) expect(scriptTokenRoute(method, path), `${method} ${path}`).toBeUndefined();
  });

  it("is on unless the owner turns it off", () => {
    expect(scriptTokensEnabled({})).toBe(true);
    expect(scriptTokensEnabled({ ROVARA_SCRIPT_TOKENS: "1" })).toBe(true);
    expect(scriptTokensEnabled({ ROVARA_SCRIPT_TOKENS: "0" })).toBe(false);
  });
});

describe("the stored tokens (document store port)", () => {
  const owner = { developerId: "a".repeat(64), personId: "local-owner", orgId: IMPLICIT_COMPANY_ID, orgRole: "owner" as const };
  const body = (n: number, extra: Record<string, unknown> = {}) => ({ requestId: REQUEST(n), name: `token ${n}`, projects: ["payments"], permissions: ["read"], ...extra });
  const world = () => {
    const store = new MemoryDocumentStore({ ttlAttribute: "indexExpiresAt" });
    const events: AuditEvent[] = [];
    let clock = Date.parse("2026-11-10T10:00:00.000Z");
    const deps: ScriptTokenDependencies = {
      store, now: () => clock, log: () => undefined,
      audit: { stage(event) { events.push(event); return []; }, async record(event) { events.push(event); } },
    };
    return { store, deps, events, advance: (ms: number) => { clock += ms; } };
  };
  const anyProject = async () => undefined;

  it("keeps the hash under Cloud's keys and never the token, and audits the making", async () => {
    const w = world();
    const made = CreatedScriptTokenSchema.parse(await createScriptToken(w.deps, owner, body(1), anyProject));
    const record = await w.store.get(scriptTokenKey(IMPLICIT_COMPANY_ID, made.token.tokenId));
    expect(record).toMatchObject({ entityType: "SCRIPT_TOKEN", secretHash: createHash("sha256").update(made.secret).digest("hex"), createdRole: "owner", amr: "local", personId: "local-owner" });
    expect(await w.store.get(orgScriptTokensKey(IMPLICIT_COMPANY_ID, made.token.tokenId))).toMatchObject({ entityType: "SCRIPT_TOKEN_ROW", developerId: owner.developerId });
    expect(ScriptTokenRecordSchema.safeParse(record).success).toBe(true);
    const everything = JSON.stringify([...(await w.store.query({ pk: scriptTokenKey(IMPLICIT_COMPANY_ID, made.token.tokenId).pk })).items, ...(await w.store.query({ pk: orgScriptTokensKey(IMPLICIT_COMPANY_ID, "stk_x").pk })).items]);
    const secretPart = made.secret.slice(-43);
    expect(everything).toContain(made.token.tokenId);
    expect(everything).not.toContain(secretPart);
    expect(JSON.stringify(w.events)).not.toContain(secretPart);
    expect(w.events.map((event) => event.action)).toEqual(["script_token.created"]);
    expect(w.events[0]).toMatchObject({ subject: { type: "script_token", id: made.token.tokenId }, details: { projects: 1, permissions: "read" } });
    expect(JSON.stringify(await listScriptTokens(w.deps, owner, async () => "Owner"))).not.toContain(secretPart);
  });

  it("refuses a repeat of the request (never answering it with the token), a different body under the same id, and a project nobody has", async () => {
    const w = world();
    await createScriptToken(w.deps, owner, body(1), anyProject);
    await expect(createScriptToken(w.deps, owner, body(1), anyProject)).rejects.toThrow(/already made and shown once/);
    await expect(createScriptToken(w.deps, owner, body(1, { name: "another" }), anyProject)).rejects.toThrow(/already used for a different request/);
    await expect(createScriptToken(w.deps, owner, body(2), async () => { throw new Error("project not found"); })).rejects.toThrow(/project not found/);
    expect((await listScriptTokens(w.deps, owner, async () => undefined))).toHaveLength(1);
  });

  it("refuses a body that does not fit, naming the field and never the value", async () => {
    const w = world();
    for (const bad of [{ ...body(1), days: 91 }, { ...body(1), permissions: ["admin"] }, { ...body(1), projects: [] }, { ...body(1), extra: 1 }, { ...body(1), name: "   " }, { name: "x" }]) {
      await expect(createScriptToken(w.deps, owner, bad, anyProject)).rejects.toThrow(/^(?!.*secret)/);
    }
    await expect(createScriptToken(w.deps, owner, { ...body(1), permissions: ["admin"] }, anyProject)).rejects.toThrow(/permissions/);
  });

  it("the lessons permission (decision 46b) is one of the three a token may have, and it is kept as asked: a token made without it has no lessons permission", async () => {
    expect(SCRIPT_TOKEN_PERMISSIONS).toEqual(["read", "start", "lessons"]);
    const asked = { requestId: REQUEST(1), name: "tool", projects: ["payments"] };
    expect(CreateScriptTokenBodySchema.safeParse({ ...asked, permissions: ["lessons"] }).success).toBe(true);
    expect(CreateScriptTokenBodySchema.safeParse({ ...asked, permissions: ["read", "start", "lessons"] }).success).toBe(true);
    expect(CreateScriptTokenBodySchema.safeParse({ ...asked, permissions: ["lessons", "lessons"] }).success).toBe(false);
    expect(CreateScriptTokenBodySchema.safeParse({ ...asked, permissions: ["lessons", "read", "start", "lessons"] }).success).toBe(false);
    const w = world();
    const withLessons = CreatedScriptTokenSchema.parse(await createScriptToken(w.deps, owner, body(1, { permissions: ["lessons", "read"] }), anyProject));
    expect(withLessons.token.permissions).toEqual(["read", "lessons"]);
    expect((await readScriptToken(w.deps, IMPLICIT_COMPANY_ID, withLessons.token.tokenId))?.permissions).toEqual(["read", "lessons"]);
    const lessonsOnly = CreatedScriptTokenSchema.parse(await createScriptToken(w.deps, owner, body(2, { permissions: ["lessons"] }), anyProject));
    expect(lessonsOnly.token.permissions).toEqual(["lessons"]);
    const without = CreatedScriptTokenSchema.parse(await createScriptToken(w.deps, owner, body(3, { permissions: ["read", "start"] }), anyProject));
    expect(without.token.permissions).toEqual(["read", "start"]);
    expect(w.events.map((event) => event.details?.["permissions"])).toEqual(["read,lessons", "lessons", "read,start"]);
    expect((await listScriptTokens(w.deps, owner, async () => "Owner")).map((view) => view.permissions)).toEqual(expect.arrayContaining([["read", "lessons"], ["lessons"], ["read", "start"]]));
  });

  it("keeps at most ten live tokens a person, and a token expires and is revoked at once", async () => {
    const w = world();
    const first = await createScriptToken(w.deps, owner, body(1, { days: 1 }), anyProject);
    for (let n = 2; n <= SCRIPT_TOKENS_PER_PERSON_MAX; n += 1) await createScriptToken(w.deps, owner, body(n), anyProject);
    // Ten made in the hour is also the hourly limit; the next hour the per-person limit is what refuses.
    await expect(createScriptToken(w.deps, owner, body(11), anyProject)).rejects.toThrow(/Too many script tokens made in the last hour/);
    w.advance(3_600_000);
    await expect(createScriptToken(w.deps, owner, body(11), anyProject)).rejects.toThrow(/up to 10 script tokens/);
    // Revoking one frees a place; revoking again answers as it is; a token of nobody is not found.
    const revoked = await revokeScriptToken(w.deps, owner, first.token.tokenId);
    expect(revoked.status).toBe("revoked");
    expect((await revokeScriptToken(w.deps, owner, first.token.tokenId)).status).toBe("revoked");
    expect(w.events.filter((event) => event.action === "script_token.revoked")).toHaveLength(1);
    await expect(revokeScriptToken(w.deps, owner, "stk_00000000000000000000")).rejects.toThrow(/not found/);
    await createScriptToken(w.deps, owner, body(12), anyProject);
    // Time passes: a one-day token is expired.
    const short = await createScriptToken({ ...w.deps }, { ...owner, developerId: "b".repeat(64) }, body(13, { days: 1 }), anyProject);
    w.advance(2 * 86_400_000);
    const listed = await listScriptTokens(w.deps, { ...owner, developerId: "b".repeat(64) }, async () => undefined);
    expect(listed.find((token) => token.tokenId === short.token.tokenId)?.status).toBe("expired");
  });

  it("notes a token's use: the day's first use is audited once, later ones only bookkeeping", async () => {
    const w = world();
    const made = await createScriptToken(w.deps, owner, body(1), anyProject);
    const read = async () => (await readScriptToken(w.deps, IMPLICIT_COMPANY_ID, made.token.tokenId))!;
    await noteScriptTokenUse(w.deps, await read(), "read");
    await noteScriptTokenUse(w.deps, await read(), "read");
    w.advance(6 * 60_000);
    await noteScriptTokenUse(w.deps, await read(), "start");
    expect(w.events.filter((event) => event.action === "script_token.used")).toHaveLength(1);
    expect((await read()).lastUsedAt).toBe("2026-11-10T10:06:00.000Z");
    w.advance(86_400_000);
    await noteScriptTokenUse(w.deps, await read(), "read");
    expect(w.events.filter((event) => event.action === "script_token.used")).toHaveLength(2);
  });

  it("limits a fixed window and starts the next one fresh", async () => {
    const w = world();
    const key = { pk: "ORG#x#RATE", sk: "a" };
    const results = [];
    for (let n = 0; n < 4; n += 1) results.push(await takeRate(w.store, key, 3, 60_000, w.deps.now));
    expect(results).toEqual([true, true, true, false]);
    w.advance(60_000);
    expect(await takeRate(w.store, key, 3, 60_000, w.deps.now)).toBe(true);
    expect(await takeRate(w.store, { pk: "ORG#x#RATE", sk: "b" }, 3, 60_000, w.deps.now)).toBe(true);
  });
});

describe("rovara up: making a token on a page, and using it", () => {
  it("makes a token on the page: shown once, stored as a hash, audited, and not on any later page or API answer", async () => {
    const h = await launch();
    const { secret, where, html } = await h.makeToken();
    expect(html).toContain("shown this once");
    const secretPart = secret.slice(-43);
    const tokenId = `stk_${secret.split("_")[2]}`;
    const record = (await h.store.get(scriptTokenKey(IMPLICIT_COMPANY_ID, tokenId)))!;
    expect(record["secretHash"]).toBe(hashScriptToken(secret));
    // Nowhere in the store, the audit events, a later page or an API answer.
    const dump = JSON.stringify((await h.store.query({ pk: scriptTokenKey(IMPLICIT_COMPANY_ID, tokenId).pk })).items) + JSON.stringify(h.events);
    expect(dump).not.toContain(secretPart);
    expect((await h.page(where, "/tokens")).body).not.toContain(secretPart);
    const listed = await h.api("/v1/app/script-tokens");
    expect(listed.status).toBe(200);
    expect(ScriptTokenListSchema.safeParse(listed.body).success).toBe(true);
    expect(listed.text).not.toContain(secretPart);
    expect(listed.body["tokens"]).toHaveLength(1);
    expect(h.events.map((event) => event.action)).toEqual(["script_token.created"]);
  });

  it("will not make a token for the API session token, or from a page session that is not fresh, or from a replayed or forged form", async () => {
    // The clock is set before the install starts: the page sessions read it from the start.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T10:00:00.000Z"));
    const h = await launch();
    // The API session token (which an AI tool may hold) cannot make one.
    const viaApi = await h.api("/v1/app/script-tokens", { method: "POST", body: { requestId: REQUEST(1), name: "x", projects: ["payments"], permissions: ["read"] } });
    expect(viaApi.status).toBe(403);
    expect(viaApi.text).toContain("rovara token create");
    // A page session opened a moment ago may; the same session later may not.
    const where = await h.browse("/tokens", true);
    const drawn = await h.page(where, "/tokens");
    expect(drawn.body).toContain("name=\"name\"");
    const form = formOf(drawn.body, "/tokens/create");
    // No form token, or one for another request: refused, nothing made.
    expect((await h.post(where, "/tokens/create", { requestId: form.fields["requestId"]!, name: "x", project: "payments", permission: "read" })).headers["location"]).toContain("n=form");
    expect((await h.post(where, "/tokens/create", { ...form.fields, requestId: REQUEST(7), name: "x", project: "payments", permission: "read" })).headers["location"]).toContain("n=form");
    expect((await h.api("/v1/app/script-tokens")).body["tokens"]).toHaveLength(0);
    // The session ages past the window before the form is sent.
    vi.setSystemTime(new Date("2026-11-10T10:11:00.000Z"));
    const stale = await h.post(where, "/tokens/create", new URLSearchParams({ ...form.fields, name: "x", project: "payments", permission: "read" }));
    expect(stale.status, stale.body).toBe(303);
    expect(stale.headers["location"]).toContain("n=tokenfresh");
    expect((await h.api("/v1/app/script-tokens")).body["tokens"]).toHaveLength(0);
    // The old page shows no form, and says how to open a fresh one.
    const old = await h.page(where, "/tokens");
    expect(old.body).not.toContain("name=\"name\"");
    expect(old.body).toContain("rovara token create");
    // Without the `fresh` ask (and not for any other page), the open route does not give a new page session.
    expect((await h.api("/v1/local/pages/open", { method: "POST", body: { path: "/", fresh: true } })).status).toBe(200);
  });

  it("the lessons page may ask for a new page session (switching a repository's lessons file on needs one), and the home page may not", async () => {
    const h = await launch();
    const first = await h.browse("/lessons", true);
    const second = await h.browse("/lessons", true);
    expect(second.base).not.toBe(first.base);
    const home = await h.browse("/", true);
    const again = await h.browse("/", true);
    expect(again.base).toBe(home.base);
  });

  it("makes a form usable once, and refuses a project it does not know and a permission it does not offer", async () => {
    const h = await launch();
    const where = await h.browse("/tokens", true);
    const form = formOf((await h.page(where, "/tokens")).body, "/tokens/create");
    const fields = (over: Record<string, string>) => new URLSearchParams({ ...form.fields, name: "CI", project: "payments", permission: "read", ...over });
    const unknown = await h.post(where, "/tokens/create", fields({ project: "nothere" }));
    expect(unknown.status).toBe(200);
    expect(unknown.body).toContain("project not found");
    expect(unknown.body).not.toMatch(/<code>rvst_/);
    // The form was spent by that try: a second post with the same form token is refused.
    expect((await h.post(where, "/tokens/create", fields({}))).headers["location"]).toContain("n=form");
    // A fresh form, a permission nobody offers.
    const again = formOf((await h.page(where, "/tokens")).body, "/tokens/create");
    const bad = await h.post(where, "/tokens/create", new URLSearchParams({ ...again.fields, name: "CI", project: "payments", permission: "approve" }));
    expect(bad.body).toContain("permissions");
    expect((await h.api("/v1/app/script-tokens")).body["tokens"]).toHaveLength(0);
  });

  it("lets a script read and start tasks on its own projects as the owner, with the fixed client, and audits the start", async () => {
    const h = await launch();
    const { secret } = await h.makeToken({ projects: ["payments"] });
    const started = await start(h, secret, 1);
    expect(started.status, started.text).toBe(201);
    const task = started.body["task"];
    // The body's client is ignored: the task's client is the token's fixed one.
    expect(task.client).toBe("Script token");
    expect(task.project).toBe("payments");
    expect((await start(h, secret, 1)).status).toBe(200);
    expect((await h.call(secret, `/v1/dev/tasks/${task.taskId}`)).body["task"]).toMatchObject({ taskId: task.taskId, client: "Script token" });
    const list = await h.call(secret, "/v1/dev/tasks?project=payments");
    expect(list.status).toBe(200);
    expect(list.body["tasks"].map((row) => row.taskId)).toEqual([task.taskId]);
    // The owner sees the same task with the session token, and it is the owner's.
    expect((await h.api(`/v1/dev/tasks/${task.taskId}`)).status).toBe(200);
    // The ledger names the token and the task.
    const actions = h.events.map((event) => event.action);
    expect(actions.filter((action) => action === "script_token.used").length).toBeGreaterThanOrEqual(2);
    expect(h.events.some((event) => event.action === "script_token.used" && JSON.stringify(event.details).includes(task.taskId))).toBe(true);
    expect(JSON.stringify(h.events)).not.toContain(secret.slice(-43));
  });

  it("works the same on SQLite, the store `rovara up` uses: make, use, rate-limit rows, revoke", async () => {
    const h = await launch({ storage: "sqlite" });
    const { secret } = await h.makeToken();
    const started = await start(h, secret, 1);
    expect(started.status, started.text).toBe(201);
    expect((await h.call(secret, "/v1/dev/tasks?project=payments")).body["tasks"]).toHaveLength(1);
    const tokenId = `stk_${secret.split("_")[2]}`;
    expect((await h.api(`/v1/app/script-tokens/${tokenId}/revoke`, { method: "POST", body: {} })).status).toBe(200);
    expect((await h.call(secret, "/v1/dev/tasks?project=payments")).status).toBe(401);
    // The rate rows and the audit-less day mark are plain documents: nothing the secret is in.
    const rows = await h.store.query({ pk: `ORG#${IMPLICIT_COMPANY_ID}#SCRIPT_TOKEN_RATE` });
    expect(rows.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows.items)).not.toContain(secret.slice(-43));
  });

  it("a token with only the lessons permission reaches nothing here (Rovara Code serves no lessons route for tools), and the page words say what it is for", async () => {
    const h = await launch();
    const made = await h.makeToken({ projects: ["payments"], permissions: ["lessons"] });
    expect(made.html).toContain("read the team lessons of these projects");
    const refused = { status: 403, body: { error: { code: "FORBIDDEN", message: SCRIPT_TOKEN_NOT_ALLOWED_MESSAGE } } };
    expect(await start(h, made.secret, 50)).toMatchObject(refused);
    expect(await h.call(made.secret, "/v1/dev/tasks?project=payments")).toMatchObject(refused);
    expect(await h.call(made.secret, "/v1/dev/projects/payments/lessons", { method: "POST", body: {} })).toMatchObject(refused);
    expect(await h.call(made.secret, "/v1/app/projects/payments/lessons")).toMatchObject(refused);
    // The create form offers all three permissions.
    const drawn = await h.page(await h.browse("/tokens", true), "/tokens");
    for (const permission of SCRIPT_TOKEN_PERMISSIONS) expect(drawn.body).toContain(`name="permission" value="${permission}"`);
  });

  it("keeps a token to its projects and permissions", async () => {
    const h = await launch();
    const reader = (await h.makeToken({ projects: ["payments"], permissions: ["read"] })).secret;
    const writer = (await h.makeToken({ projects: ["payments"], permissions: ["start"] })).secret;
    const other = await h.api("/v1/dev/tasks", { method: "POST", body: { requestId: REQUEST(40), project: "billing", instructions: "Other work" } });
    expect(other.status).toBe(201);
    const mine = (await start(h, writer, 41)).body["task"].taskId;
    // A read-only token cannot start; a start-only token cannot read; neither names a project it was not made for.
    const noStart = await start(h, reader, 42);
    expect(noStart.status).toBe(403);
    expect(noStart.body).toEqual({ error: { code: "FORBIDDEN", message: SCRIPT_TOKEN_NOT_ALLOWED_MESSAGE } });
    expect((await h.call(writer, `/v1/dev/tasks/${mine}`)).status).toBe(403);
    expect((await start(h, writer, 43, "billing")).status).toBe(403);
    // A task of another project answers as a missing one; a list never shows it, whatever it asks for.
    expect((await h.call(reader, `/v1/dev/tasks/${other.body["task"].taskId}`)).status).toBe(404);
    expect((await h.call(reader, `/v1/dev/tasks/${mine}`)).status).toBe(200);
    expect((await h.call(reader, "/v1/dev/tasks?project=billing")).status).toBe(403);
    expect((await h.call(reader, "/v1/dev/tasks")).status).toBe(403);
    expect((await h.call(reader, "/v1/dev/tasks?project=payments")).body["tasks"].map((row) => row.taskId)).toEqual([mine]);
  });

  it("is never an approval: every other route of the owner's API is refused with one fixed text, and a plan stays waiting", async () => {
    const h = await launch();
    const { secret } = await h.makeToken();
    const task = (await start(h, secret, 1)).body["task"].taskId;
    const forbidden = [
      ["POST", `/v1/dev/tasks/${task}/workflow/decision`, { requestId: REQUEST(2), decision: "APPROVE" }], ["POST", `/v1/dev/tasks/${task}/close`, {}], ["POST", `/v1/dev/tasks/${task}/cancel`, { requestId: REQUEST(3) }],
      ["POST", `/v1/dev/tasks/${task}/workflow/retry`, { requestId: REQUEST(4) }], ["POST", `/v1/dev/tasks/${task}/thread`, {}], ["GET", `/v1/dev/tasks/${task}/plan`, undefined],
      ["GET", "/v1/dev/projects", undefined], ["POST", "/v1/admin/projects", project("sneaky")], ["GET", "/v1/app/sessions", undefined], ["POST", "/v1/app/sessions/ses_00000000000000000000/stop", { requestId: REQUEST(5) }],
      ["POST", "/v1/local/pages/open", { path: "/" }], ["GET", "/v1/local/status", undefined], ["GET", "/v1/app/script-tokens", undefined], ["POST", "/v1/app/script-tokens", { requestId: REQUEST(6), name: "mine", projects: ["payments"], permissions: ["read", "start"] }],
      ["POST", "/v1/app/script-tokens/stk_00000000000000000000/revoke", {}],
    ] as const;
    const opened = (await h.api("/v1/local/status")).status;
    expect(opened).toBe(200);
    for (const [method, path, body] of forbidden) {
      const answer = await h.call(secret, path, { method, ...(body === undefined ? {} : { body }) });
      expect(answer.status, `${method} ${path}`).toBe(403);
      expect(answer.body).toEqual({ error: { code: "FORBIDDEN", message: SCRIPT_TOKEN_NOT_ALLOWED_MESSAGE } });
      expect(answer.text).not.toContain(secret);
      expect(answer.text).not.toContain(path);
    }
    // Nothing was decided, closed or registered; no page was opened, no token was made.
    const view = (await h.api(`/v1/dev/tasks/${task}`)).body["task"];
    expect(view.workflow.decisions).toEqual([]);
    expect(view.closing).toBeUndefined();
    expect((await h.api("/v1/dev/projects")).body["projects"].map((entry) => entry.name)).not.toContain("sneaky");
    expect((await h.api("/v1/app/script-tokens")).body["tokens"]).toHaveLength(1);
  });

  it("is refused when it is malformed, unknown or of another company, and the answer never echoes it", async () => {
    const h = await launch();
    const { secret } = await h.makeToken();
    const forged = `rvst_${"0".repeat(20)}_${secret.split("_")[2]}_${"A".repeat(43)}`;
    const elsewhere = `rvst_${"1".repeat(20)}_${secret.split("_")[2]}_${secret.split("_")[3]}`;
    for (const bad of [forged, elsewhere, "rvst_nope", `${secret}x`]) {
      const answer = await h.call(bad, "/v1/dev/tasks?project=payments");
      expect(answer.status, bad).toBe(401);
      expect(answer.text).not.toContain(bad);
      expect(answer.body["error"]).toMatchObject({ code: "AUTH_REQUIRED" });
    }
    // The right token still works (a wrong guess did not lock it).
    expect((await h.call(secret, "/v1/dev/tasks?project=payments")).status).toBe(200);
  });

  it("is revoked at once from the API or the page, and a revoked token never comes back", async () => {
    const h = await launch();
    const first = await h.makeToken();
    const second = await h.makeToken({ name: "second" });
    expect((await h.call(first.secret, "/v1/dev/tasks?project=payments")).status).toBe(200);
    const firstId = `stk_${first.secret.split("_")[2]}`;
    // A token cannot revoke (or list) tokens; the owner's session token can.
    expect((await h.call(second.secret, `/v1/app/script-tokens/${firstId}/revoke`, { method: "POST", body: {} })).status).toBe(403);
    const revoked = await h.api(`/v1/app/script-tokens/${firstId}/revoke`, { method: "POST", body: {} });
    expect(revoked.status, revoked.text).toBe(200);
    expect(revoked.body["token"]).toMatchObject({ tokenId: firstId, status: "revoked" });
    const refused = await h.call(first.secret, "/v1/dev/tasks?project=payments");
    expect(refused.status).toBe(401);
    expect(refused.text).toContain("revoked");
    // From the page: a Revoke button for each live token.
    const where = await h.browse("/tokens");
    const secondId = `stk_${second.secret.split("_")[2]}`;
    const drawn = await h.page(where, "/tokens");
    expect(drawn.body).toContain(`value="${secondId}"`);
    const form = formOf(drawn.body, "/tokens/revoke");
    const sent = await h.post(where, "/tokens/revoke", form.fields);
    expect(sent.headers["location"]).toContain("n=revoked");
    expect((await h.call(second.secret, "/v1/dev/tasks?project=payments")).status).toBe(401);
    expect(h.events.filter((event) => event.action === "script_token.revoked")).toHaveLength(2);
    expect((await h.api("/v1/app/script-tokens/stk_00000000000000000000/revoke", { method: "POST", body: {} })).status).toBe(404);
  });

  it("stops working when the person who made it is no longer the owner with that role, and is revoked for good", async () => {
    const h = await launch();
    const { secret } = await h.makeToken();
    const tokenId = `stk_${secret.split("_")[2]}`;
    // Cloud's "role changed" case: the record says the token was made with a role the person no longer holds.
    await h.store.update({ key: scriptTokenKey(IMPLICIT_COMPANY_ID, tokenId), ops: [{ op: "set", path: ["createdRole"], value: "admin" }] });
    const refused = await h.call(secret, "/v1/dev/tasks?project=payments");
    expect(refused.status).toBe(401);
    expect(refused.text).toContain("creator's access changed");
    expect((await h.store.get(scriptTokenKey(IMPLICIT_COMPANY_ID, tokenId)))!["revokedBy"]).toBe("rovara");
    await h.store.update({ key: scriptTokenKey(IMPLICIT_COMPANY_ID, tokenId), ops: [{ op: "set", path: ["createdRole"], value: "owner" }] });
    expect((await h.call(secret, "/v1/dev/tasks?project=payments")).text).toContain("revoked");
    expect(h.events.some((event) => event.action === "script_token.revoked" && JSON.stringify(event.details).includes("access_changed"))).toBe(true);
  });

  it("is rate limited per token, and start-limited per hour", async () => {
    const h = await launch();
    const { secret } = await h.makeToken();
    let limited = 0;
    for (let n = 0; n < 62; n += 1) if ((await h.call(secret, "/v1/dev/tasks?project=payments")).status === 429) limited += 1;
    // 60 a minute: the first minute may roll over during the loop, so at least one and at most two are refused.
    expect(limited).toBeGreaterThanOrEqual(1);
    expect(limited).toBeLessThanOrEqual(2);
  });

  it("is expired by its own days, and ends at the install's switch", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T10:00:00.000Z"));
    const h = await launch();
    const { secret } = await h.makeToken({ days: "1" });
    expect((await h.call(secret, "/v1/dev/tasks?project=payments")).status).toBe(200);
    vi.setSystemTime(new Date("2026-11-11T10:00:01.000Z"));
    const expired = await h.call(secret, "/v1/dev/tasks?project=payments");
    expect(expired.status).toBe(401);
    expect(expired.text).toContain("expired");
  });

  it("does not exist when the owner turns it off: no page, no routes, and a stored token is refused", async () => {
    const on = await launch();
    const made = await on.makeToken();
    const off = await launch({ environment: { ROVARA_SCRIPT_TOKENS: "0" } });
    const where = await off.browse("/tokens", true);
    expect((await off.page(where, "/tokens")).status).toBe(404);
    expect((await off.api("/v1/app/script-tokens")).status).not.toBe(200);
    const refused = await off.call(made.secret, "/v1/dev/tasks?project=payments");
    expect(refused.status).toBe(401);
    expect(refused.text).toContain("turned off");
  });

  it("never lets a token reach the older broker handler, the page server, the callback listener or the model proxy", async () => {
    const h = await launch();
    const { secret } = await h.makeToken();
    for (const path of ["/v1/workspaces", "/v1/internal/model-access", "/healthz-x", "/v1/dev/tasks/not-a-uuid"]) {
      const answer = await h.call(secret, path);
      expect([401, 403, 404]).toContain(answer.status);
    }
    // The pages' sessions are the owner's: a token is no page session.
    const response = await raw(h.runtime.pagesUrl, { path: `/s/${secret.slice(5, 48).padEnd(43, "a")}/tokens`, headers: { host: new URL(h.runtime.pagesUrl).host } });
    expect(response.status).toBe(404);
  });
});

describe("review fixes", () => {
  it("L3a: a token's other methods on a task are refused with the fixed text", async () => {
    const h = await launch();
    const { secret } = await h.makeToken();
    const task = (await start(h, secret, 1)).body["task"].taskId;
    for (const path of [`/v1/dev/tasks/${task}`, `/v1/dev/tasks/${task}/events`]) {
      const answer = await h.call(secret, path, { method: "POST", body: {} });
      expect(answer.status, path).toBe(403);
      expect(answer.body).toEqual({ error: { code: "FORBIDDEN", message: SCRIPT_TOKEN_NOT_ALLOWED_MESSAGE } });
    }
  });

  it("L3b: the list itself shows a token's projects only, even if the check before it were wrong", async () => {
    const h = await launch();
    const mine = await h.api("/v1/dev/tasks", { method: "POST", body: { requestId: REQUEST(50), project: "payments", instructions: "One" } });
    await h.api("/v1/dev/tasks", { method: "POST", body: { requestId: REQUEST(51), project: "billing", instructions: "Two" } });
    const caller = { principal: localOwnerPrincipal(), scriptToken: { tokenId: "stk_00000000000000000000", name: "x", permissions: ["read" as const], projects: ["payments"] } };
    const answer = await h.runtime.app.routes({ method: "GET", path: "/v1/dev/tasks", headers: {} }, caller);
    const tasks = (JSON.parse(answer!.body) as Json).tasks;
    expect(tasks.map((row) => row.taskId)).toEqual([mine.body["task"].taskId]);
  });

  it("L1: a path the router and the check could read differently is refused", async () => {
    const h = await launch();
    const { secret } = await h.makeToken();
    const host = new URL(h.runtime.url).host;
    for (const path of ["/v1/dev/x/../tasks?project=payments", "/v1/dev/tasks/%2e%2e/tasks?project=payments", "/v1/dev\\tasks?project=payments", "/v1/dev/tasks#x?project=payments", "/v1/dev/tasks?project=payments#y"]) {
      const answer = await raw(h.runtime.url, { path, headers: { host, authorization: `Bearer ${secret}` } });
      expect(answer.status, path).toBe(403);
    }
    // Node refuses a tab in a path on the wire, so the check is also asked directly.
    const direct = await h.runtime.app.scriptTokens.serve({ method: "GET", path: "/v1/dev/ta\tsks?project=payments", headers: { authorization: `Bearer ${secret}` } }, async () => undefined);
    expect(direct.statusCode).toBe(403);
    expect((await h.call(secret, "/v1/dev/tasks?project=payments")).status).toBe(200);
  });

  it("L4: turning the switch off ends every token for good; turning it back on revives nothing", async () => {
    const first = await launch({ storage: "sqlite" });
    const { secret } = await first.makeToken();
    const tokenId = `stk_${secret.split("_")[2]}`;
    expect((await first.call(secret, "/v1/dev/tasks?project=payments")).status).toBe(200);
    await first.runtime.stop();
    const off = await launch({ storage: "sqlite", root: first.root, environment: { ROVARA_SCRIPT_TOKENS: "0" } });
    expect((await off.store.get(scriptTokenKey(IMPLICIT_COMPANY_ID, tokenId)))!["revokedBy"]).toBe("rovara");
    expect(off.events.some((event) => event.action === "script_token.revoked" && JSON.stringify(event.details).includes("switch_off"))).toBe(true);
    await off.runtime.stop();
    const on = await launch({ storage: "sqlite", root: first.root });
    const refused = await on.call(secret, "/v1/dev/tasks?project=payments");
    expect(refused.status).toBe(401);
    expect(refused.text).toContain("revoked");
  });

  it("L4: restarting with the switch on revokes nothing: a live token survives and still works", async () => {
    const first = await launch({ storage: "sqlite" });
    const { secret } = await first.makeToken();
    const tokenId = `stk_${secret.split("_")[2]}`;
    await first.runtime.stop();
    const again = await launch({ storage: "sqlite", root: first.root });
    const record = (await again.store.get(scriptTokenKey(IMPLICIT_COMPANY_ID, tokenId)))!;
    expect(record["revokedAt"]).toBeUndefined();
    expect(again.events.filter((event) => event.action === "script_token.revoked")).toEqual([]);
    expect((await again.call(secret, "/v1/dev/tasks?project=payments")).status).toBe(200);
  });

  it("M1: at the cap a fresh session is dropped before any other, however old the others are", () => {
    const sessions = new LocalPageSessions();
    const normal = Array.from({ length: MAX_SESSIONS - 2 }, () => sessions.mint().token);
    const fresh = [sessions.mint({ fresh: true }).token, sessions.mint({ fresh: true }).token];
    sessions.mint();
    expect(sessions.find(fresh[0])).toBeUndefined();
    expect(sessions.find(fresh[1])).toBeDefined();
    for (const token of normal) expect(sessions.find(token)).toBeDefined();
  });

  it("M1: fresh page sessions are few, short and dropped first, so repeated opens never push the owner's session out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T10:00:00.000Z"));
    const h = await launch();
    const owner = await h.browse("/");
    expect((await h.page(owner, "/")).status).toBe(200);
    const sessions = h.runtime.app.pages.sessions;
    const fresh: Array<{ base: string; host: string }> = [];
    for (let n = 0; n < 17; n += 1) {
      const once = new URL(h.runtime.app.pages.onceLink("/tokens", { fresh: true }));
      const hop = await raw(h.runtime.pagesUrl, { path: once.pathname, headers: { host: once.host } });
      const location = new URL(hop.headers["location"] as string, h.runtime.pagesUrl);
      fresh.push({ base: location.pathname.split("/").slice(0, 3).join("/"), host: location.host });
    }
    // The owner's session still works; only the last few fresh ones do.
    expect((await h.page(owner, "/")).status).toBe(200);
    const working = [];
    for (const where of fresh) working.push((await h.page(where, "/tokens")).status);
    expect(working.filter((status) => status === 200)).toHaveLength(3);
    expect(working.slice(-3)).toEqual([200, 200, 200]);
    expect(sessions).toBeDefined();
    // A fresh session ends after 15 minutes; the owner's lasts hours.
    vi.setSystemTime(new Date("2026-11-10T10:16:00.000Z"));
    expect((await h.page(fresh.at(-1)!, "/tokens")).status).toBe(404);
    expect((await h.page(owner, "/")).status).toBe(200);
  });
});
