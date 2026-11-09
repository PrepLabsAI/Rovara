// Lane L8: `sessions` and `session *` against a scripted broker (no task flow needed): what is sent, what is printed, and which links are printed.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { developerTokenKey, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { safeUrl } from "../../packages/cli/src/session/commands.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";

const ORIGIN = "http://127.0.0.1:4410";
const ISSUER = `${ORIGIN}/v1/auth`;
const SESSION = `ses_${"a".repeat(20)}`;
const entry = { url: ORIGIN, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

type Script = (call: { method: string; path: string; body: Record<string, unknown> | undefined }) => { status?: number; body: Record<string, unknown> };

async function cli(script: Script) {
  const home = await mkdtemp(join(tmpdir(), "rovara-session-cli-"));
  dirs.push(home);
  await saveDeveloperEnvironment(home, "local", entry);
  const tokenStore = new InMemoryTokenStore();
  await tokenStore.set(developerTokenKey(ISSUER), { accessToken: "local-owner-token", refreshToken: `agxr_${"a".repeat(43)}`, expiresAt: Date.now() + 3_600_000 });
  const out: string[] = [];
  const err: string[] = [];
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | undefined; auth: string | undefined }> = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    const method = init?.method ?? "GET";
    calls.push({ method, path: target.pathname + target.search, body, auth: new Headers(init?.headers).get("authorization") ?? undefined });
    const reply = script({ method, path: target.pathname + target.search, body });
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  };
  const run = (argv: string[]) => executeCli(["--env", "local", ...argv], { fetchImplementation, tokenStore, environments: { home }, stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) } });
  return { run, text: () => out.join(""), errors: () => err.join(""), calls };
}

describe("printing a link", () => {
  it("accepts https and, for an install on this computer, http on the same loopback origin", () => {
    expect(safeUrl("https://app.example.test/app/sessions/x", "https://app.example.test")).toBeDefined();
    expect(safeUrl("http://127.0.0.1:4410/app/sessions/x", ORIGIN)).toBe("http://127.0.0.1:4410/app/sessions/x");
    expect(safeUrl("http://localhost:4410/x", "http://localhost:4410")).toBeDefined();
  });

  it("never prints a local page address, which carries a session token that can approve", () => {
    const token = "B".repeat(43);
    expect(safeUrl(`${ORIGIN}/s/${token}/plan/1`, ORIGIN)).toBeUndefined();
    expect(safeUrl(`https://app.example.test/s/${token}`, "https://app.example.test")).toBeUndefined();
    expect(safeUrl(`${ORIGIN}/s/short/plan/1`, ORIGIN)).toBeDefined();
  });

  it("refuses http anywhere else, another port or host, and credentials", () => {
    expect(safeUrl("http://app.example.test/x", "http://app.example.test")).toBeUndefined();
    expect(safeUrl("http://127.0.0.1:4411/x", ORIGIN)).toBeUndefined();
    expect(safeUrl("http://127.0.0.1:4410@evil.example/x", ORIGIN)).toBeUndefined();
    expect(safeUrl("http://user:pw@127.0.0.1:4410/x", ORIGIN)).toBeUndefined();
    expect(safeUrl("http://127.0.0.1:4410/x", "https://app.example.test")).toBeUndefined();
    expect(safeUrl("https://app.example.test/x y", "https://app.example.test")).toBeUndefined();
    expect(safeUrl("javascript:alert(1)", ORIGIN)).toBeUndefined();
  });
});

describe("the session commands", () => {
  it("lists sessions the person owns, with the bearer token and the owner scope", async () => {
    const h = await cli(() => ({ body: { sessions: [{ sessionId: SESSION, title: "Fix retries", project: "payments", owner: { name: "Dana" }, summary: { status: "running" } }] } }));
    expect(await h.run(["sessions"]), h.errors()).toBe(0);
    expect(h.calls[0]).toMatchObject({ method: "GET", path: "/v1/app/sessions?owner=me", auth: "Bearer local-owner-token" });
    expect(h.text()).toContain(SESSION);
    expect(h.text()).toContain("Fix retries");
  });

  it("starts work on a project and prints the link to the local page", async () => {
    const h = await cli(() => ({ body: { task: { taskId: "0b4f2b1e-3c6a-4d2e-9a77-5f1d8c0a1e11", sessionId: SESSION, sessionUrl: `${ORIGIN}/app/sessions/${SESSION}` } } }));
    expect(await h.run(["session", "start", "fix the flaky retry test", "--project", "payments", "--workflow", "full"]), h.errors()).toBe(0);
    expect(h.calls[0]).toMatchObject({ method: "POST", path: "/v1/dev/tasks", body: { project: "payments", instructions: "fix the flaky retry test", workflow: true, workflowPath: "FULL" } });
    expect(h.text()).toContain(`${ORIGIN}/app/sessions/${SESSION}`);
  });

  it("refuses a link from the server that points elsewhere, and falls back to the session's own address", async () => {
    const h = await cli(() => ({ body: { task: { taskId: "0b4f2b1e-3c6a-4d2e-9a77-5f1d8c0a1e11", sessionId: SESSION, sessionUrl: "http://evil.example/steal" } } }));
    expect(await h.run(["session", "start", "do it", "--project", "payments"]), h.errors()).toBe(0);
    expect(h.text()).not.toContain("evil.example");
  });

  it("sends a comment and a message to the agent, and stops and retries", async () => {
    const h = await cli(({ path }) => ({ body: path.endsWith("/messages") ? { delivery: { state: "queued" } } : { session: { sessionId: SESSION, title: "Fix retries" }, stop: "STOPPED" } }));
    expect(await h.run(["session", "comment", SESSION, "looks right"]), h.errors()).toBe(0);
    expect(await h.run(["session", "tell", SESSION, "use two tries"]), h.errors()).toBe(0);
    expect(await h.run(["session", "stop", SESSION]), h.errors()).toBe(0);
    expect(await h.run(["session", "retry", SESSION]), h.errors()).toBe(0);
    expect(h.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `POST /v1/app/sessions/${SESSION}/messages`, `POST /v1/app/sessions/${SESSION}/messages`, `POST /v1/app/sessions/${SESSION}/stop`, `POST /v1/app/sessions/${SESSION}/retry`,
    ]);
    expect(h.calls[0]!.body).toMatchObject({ kind: "comment", text: "looks right" });
    expect(h.calls[1]!.body).toMatchObject({ kind: "steer", text: "use two tries" });
    expect(h.text()).toContain("Queued");
  });

  it("prints a refusal in the broker's words, made safe for a terminal, and exits with its code", async () => {
    const h = await cli(() => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "you cannot\u001b[31m do that" } } }));
    expect(await h.run(["session", "stop", SESSION])).toBe(4);
    expect(h.errors()).toContain("[U+001B]");
    expect(h.errors()).not.toContain("\u001b");
  });

  it("refuses an id that cannot be a session before sending anything", async () => {
    const h = await cli(() => ({ body: {} }));
    expect(await h.run(["session", "show", "../etc/passwd"])).toBe(2);
    expect(h.calls).toEqual([]);
  });

  it("shares only with a developer id, a project or the company, never an email", async () => {
    const h = await cli(() => ({ body: { share: {} } }));
    expect(await h.run(["session", "share", SESSION, "--with", "dana@example.test", "--level", "view"])).toBe(2);
    expect(h.calls).toEqual([]);
    expect(await h.run(["session", "share", SESSION, "--with", "a".repeat(64), "--level", "view"]), h.errors()).toBe(0);
    expect(h.calls[0]!.body).toMatchObject({ principal: { kind: "member", developerId: "a".repeat(64) }, level: "view" });
  });

  it("does not register the Cloud-only commands", async () => {
    const h = await cli(() => ({ body: {} }));
    for (const name of ["merge", "link"]) expect(await h.run(["session", name, SESSION]), name).not.toBe(0);
  });
});
