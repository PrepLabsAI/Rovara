// #1548: `rovara session watch <session-id>` against a scripted broker: what it asks for, what it prints, and when it stops.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionActivityEvent, SessionActivityPage } from "@agentx/contracts";
import { developerTokenKey, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { sessionWatch } from "../../packages/cli/src/session/watch.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";

const ORIGIN = "http://127.0.0.1:4410";
const ISSUER = `${ORIGIN}/v1/auth`;
const SESSION = `ses_${"a".repeat(20)}`;
const PLAN = "op-plan";
const CODE = "op-code";
const entry = { url: ORIGIN, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const operations: SessionActivityPage["operations"] = [
  { operationId: PLAN, kind: "agent_step", step: "plan", status: "SUCCEEDED", createdAt: "2026-11-26T10:00:00.000Z" },
  { operationId: CODE, kind: "agent_step", step: "code", status: "RUNNING", createdAt: "2026-11-26T10:05:00.000Z" },
];
const event = (operationId: string, sequence: number, type: string, payload: unknown): SessionActivityEvent => ({ operationId, sequence, type, timestamp: "2026-11-26T10:00:00.000Z", payload });
const page = (events: SessionActivityEvent[], cursor: string | undefined, active: boolean): SessionActivityPage => ({ operations, events, ...(cursor === undefined ? {} : { cursor }), active });
const assistant = (text: string) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], model: "m" } });

/** A scripted broker: `pages[n]` answers the n-th activity request; anything else is a 404. */
async function harness(pages: Array<SessionActivityPage | "unreachable">) {
  const home = await mkdtemp(join(tmpdir(), "rovara-session-watch-"));
  dirs.push(home);
  await saveDeveloperEnvironment(home, "laptop", entry);
  const tokenStore = new InMemoryTokenStore();
  await tokenStore.set(developerTokenKey(ISSUER), { accessToken: "local-owner-token", refreshToken: `agxr_${"a".repeat(43)}`, expiresAt: Date.now() + 3_600_000 });
  const out: string[] = [];
  const err: string[] = [];
  const paths: string[] = [];
  const sleeps: number[] = [];
  const fetchImplementation: typeof fetch = async (input) => {
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    paths.push(target.pathname + target.search);
    const next = target.pathname.endsWith("/activity") ? pages.shift() : undefined;
    if (next === "unreachable") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(next ?? { error: { code: "NOT_FOUND", message: "route not found" } }), { status: next === undefined ? 404 : 200, headers: { "content-type": "application/json" } });
  };
  const run = (argv: string[]) => executeCli(["--env", "laptop", ...argv], { fetchImplementation, tokenStore, environments: { home }, stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) } });
  const watch = (follow: boolean) => sessionWatch({ home, tokenStore, fetch: fetchImplementation, sleep: async (ms) => { sleeps.push(ms); } }, "laptop", SESSION, { follow, json: false, write: (text) => out.push(text) });
  return { run, watch, text: () => out.join(""), errors: () => err.join(""), paths, sleeps };
}

describe("rovara session watch", () => {
  it("--no-follow prints what has happened so far, step by step, and stops", async () => {
    const h = await harness([page([
      event(PLAN, 1, "lifecycle", { status: "RUNNING" }),
      event(PLAN, 2, "progress", assistant("Reading the auth module.\nThen the tests.")),
      event(PLAN, 3, "tool_start", { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "src/auth.ts" } }),
      event(PLAN, 4, "tool_end", { type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: { content: [{ type: "text", text: "export function login() {}\nmore" }] }, isError: false, durationMs: 12 }),
      event(CODE, 1, "progress", { message: "Installing dependencies" }),
    ], "c1", true)]);
    expect(await h.run(["session", "watch", SESSION, "--no-follow"]), h.errors()).toBe(0);
    expect(h.paths).toEqual([`/v1/app/sessions/${SESSION}/activity?limit=200`]);
    const text = h.text();
    expect(text).toContain("── plan (succeeded) ──");
    expect(text).toContain("· Step running.");
    expect(text).toMatch(/agent: Reading the auth module\.\n\s+Then the tests\./);
    expect(text).toContain("→ read {\"path\":\"src/auth.ts\"}");
    expect(text).toContain("✓ read (12 ms): export function login() {}");
    expect(text).toContain("── code (running) ──");
    expect(text).toContain("· Installing dependencies");
    expect(text).not.toContain("The session has ended.");
  });

  it("follows with the cursor until the session ends, printing a tool's start once and its end when it comes", async () => {
    const h = await harness([
      page([event(CODE, 1, "tool_start", { type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: { command: "npm test" } })], "c1", true),
      page([], "c1", true),
      page([event(CODE, 2, "tool_end", { type: "tool_execution_end", toolCallId: "t2", toolName: "bash", result: { content: [{ type: "text", text: "1 failing" }] }, isError: true })], "c2", false),
    ]);
    await h.watch(true);
    expect(h.paths.map((path) => new URL(path, ORIGIN).searchParams.get("after"))).toEqual([null, "c1", "c1"]);
    const text = h.text();
    expect(text.match(/── code/g)).toHaveLength(1);
    expect(text.match(/→ bash/g)).toHaveLength(1);
    expect(text).toContain("✗ bash: 1 failing");
    expect(text.trimEnd().endsWith("The session has ended.")).toBe(true);
    // Soon after something happened, then less often while nothing did.
    expect(h.sleeps).toEqual([1_000, 1_500]);
  });

  it("asks again at once while pages come back full", async () => {
    const full = Array.from({ length: 200 }, (_unused, index) => event(CODE, index + 1, "progress", { message: `step ${index + 1}` }));
    const h = await harness([page(full, "c200", true), page([event(CODE, 201, "progress", { message: "last" })], "c201", false)]);
    await h.watch(true);
    expect(h.sleeps).toEqual([]);
    expect(h.text()).toContain("· last");
  });

  it("keeps watching through a moment the server cannot be reached", async () => {
    const h = await harness(["unreachable", page([event(CODE, 1, "progress", { message: "back" })], "c1", false)]);
    await h.watch(true);
    expect(h.text()).toContain("· back");
    expect(h.sleeps).toEqual([5_000]);
  });

  it("never lets the agent's text move or recolour the terminal", async () => {
    const h = await harness([page([event(CODE, 1, "progress", assistant("red \u001b[31mtext\u001b[0m and \u0007bell"))], undefined, false)]);
    await h.watch(false);
    expect(h.text()).not.toContain("\u001b");
    expect(h.text()).not.toContain("\u0007");
    expect(h.text()).toContain("[U+001B][31mtext");
  });

  it("--json prints each event as one line of JSON", async () => {
    const events = [event(CODE, 1, "progress", { message: "one" }), event(CODE, 2, "progress", { message: "two" })];
    const h = await harness([page(events, "c2", false)]);
    expect(await h.run(["--json", "session", "watch", SESSION]), h.errors()).toBe(0);
    expect(h.text().trim().split("\n").map((line) => JSON.parse(line) as unknown)).toEqual(events);
  });

  it("refuses what cannot be a session ID before asking anything", async () => {
    const h = await harness([]);
    expect(await h.run(["session", "watch", "not-a-session", "--no-follow"])).not.toBe(0);
    expect(h.paths).toEqual([]);
  });
});
