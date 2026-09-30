// tests/contract/admin-changes-cli.test.ts
// Spec 025 FR-052, E17: the CLI exports change records, and grants or revokes project access
// through the change path: it shows the effect, asks, and applies with the cli method.
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { askToApply, exportChanges, runCliChange } from "../../packages/cli/src/admin/changes.js";
import { parseSince } from "../../packages/cli/src/admin/turns.js";
import { tokenStoreKey } from "../../packages/cli/src/auth.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";

const URL = "https://abc123.execute-api.us-east-1.amazonaws.com";
const CHANGE = "55555555-5555-4555-8555-555555555555";
const view = (status: string) => ({ changeId: CHANGE, kind: "grant_project_access", status, effect: "Grant Slack user U0NEW00001 (not signed in to AgentX yet; the grant applies when they sign in with Slack) access to project payments.", methodsOffered: ["cli"], createdAt: "2026-10-02T09:00:00.000Z", expiresAt: "2026-10-02T09:10:00.000Z", ...(status === "applied" ? { methodUsed: "cli" } : {}) });

function control(answers: Record<string, unknown>) {
  const calls: Array<{ method: string; path: string; body?: unknown; headers?: Record<string, string> }> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new globalThis.URL(input instanceof Request ? input.url : input);
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    calls.push({ method: init?.method ?? "GET", path: `${url.pathname}${url.search}`, ...(init?.body === undefined ? {} : { body: JSON.parse(init.body as string) as unknown }), headers: init?.headers as Record<string, string> });
    const answer = answers[key];
    if (answer instanceof Response) return answer;
    return Response.json(answer ?? { error: { code: "NOT_FOUND", message: "route not found" } }, { status: answer === undefined ? 404 : 200 });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const refusal = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status });

describe("runCliChange (E17, Q6)", () => {
  it("proposes with the cli method, prints the effect, asks, and applies", async () => {
    const { fetch, calls } = control({ "POST /v1/admin/changes": { change: view("pending") }, [`POST /v1/admin/changes/${CHANGE}/apply`]: { change: view("applied") } });
    const lines: string[] = [];
    const confirm = vi.fn(async () => true);
    const result = await runCliChange({ controlPlaneUrl: URL, accessToken: "admin-token", change: { kind: "grant_project_access", project: "payments", developer: "U0NEW00001" }, cliVersion: "0.0.7", confirm, write: (line) => lines.push(line) }, fetch);
    expect(result.outcome).toBe("applied");
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v1/admin/changes", body: { change: { kind: "grant_project_access", project: "payments", developer: "U0NEW00001" }, client: { cliVersion: "0.0.7" }, methods: ["cli"] } });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Grant Slack user U0NEW00001"));
    expect(calls[1]).toMatchObject({ method: "POST", path: `/v1/admin/changes/${CHANGE}/apply`, body: { method: "cli" } });
    expect(lines.join("\n")).toContain("Applied.");
  });

  it("declines on no, and applies nothing", async () => {
    const { fetch, calls } = control({ "POST /v1/admin/changes": { change: view("pending") }, [`POST /v1/admin/changes/${CHANGE}/decline`]: { change: view("declined") } });
    const result = await runCliChange({ controlPlaneUrl: URL, accessToken: "admin-token", change: { kind: "revoke_project_access", project: "payments", developer: "U0NEW00001" }, cliVersion: "0.0.7", confirm: async () => false, write: () => undefined }, fetch);
    expect(result.outcome).toBe("declined");
    expect(calls.map((call) => call.path)).toEqual(["/v1/admin/changes", `/v1/admin/changes/${CHANGE}/decline`]);
    expect(calls[1]?.body).toEqual({ method: "cli", reason: "declined", answeredAt: expect.any(String) as unknown });
  });

  it("keeps AgentX's own refusal code", async () => {
    const fetch = vi.fn(async () => Response.json({ error: { code: "NOT_FOUND", message: "nobody has signed in to AgentX with new@example.com yet; name them by Slack user ID, or ask them to sign in first" } }, { status: 404 })) as unknown as typeof globalThis.fetch;
    await expect(runCliChange({ controlPlaneUrl: URL, accessToken: "t", change: { kind: "grant_project_access", project: "payments", developer: "new@example.com" }, cliVersion: "0.0.7", confirm: async () => true, write: () => undefined }, fetch)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("sends one request ID and one trace ID, and the proposal's own ID when given", async () => {
    const { fetch, calls } = control({ "POST /v1/admin/changes": { change: view("pending") }, [`POST /v1/admin/changes/${CHANGE}/apply`]: { change: view("applied") } });
    await runCliChange({ controlPlaneUrl: `${URL}/`, accessToken: "admin-token", change: { kind: "grant_project_access", project: "payments", developer: "U0NEW00001" }, cliVersion: "0.0.7", confirm: async () => true, write: () => undefined, newId: () => "77777777-7777-4777-8777-777777777777" }, fetch);
    expect(calls[0]?.body).toMatchObject({ requestId: "77777777-7777-4777-8777-777777777777" });
    expect(calls[0]?.headers?.authorization).toBe("Bearer admin-token");
    const traces = calls.map((call) => call.headers?.["x-agentx-trace-id"]);
    expect(traces[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(traces).size).toBe(1);
    expect(calls[1]?.body).toMatchObject({ method: "cli", requestedAt: expect.any(String) as unknown, answeredAt: expect.any(String) as unknown });
  });

  it("reads a newer control plane's answer loosely, and never calls an unknown status applied (R1)", async () => {
    const { fetch, calls } = control({
      "POST /v1/admin/changes": { change: { ...view("pending"), kind: "grant_project_access_v2", methodsOffered: ["cli", "carrier_pigeon"], extra: { nested: true } }, future: 1 },
      [`POST /v1/admin/changes/${CHANGE}/apply`]: { change: { ...view("queued"), extra: true } },
    });
    const lines: string[] = [];
    await expect(runCliChange({ controlPlaneUrl: URL, accessToken: "admin-token", change: { kind: "grant_project_access", project: "payments", developer: "U0NEW00001" }, cliVersion: "0.0.7", confirm: async () => true, write: (line) => lines.push(line) }, fetch))
      .rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: expect.stringContaining("agentx admin changes") as unknown });
    expect(calls).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("Applied.");
  });

  it("asks nothing and applies nothing when the change is not pending, or the CLI prompt was not offered", async () => {
    for (const planned of [view("expired"), view("mystery"), { ...view("pending"), methodsOffered: ["slack"] }]) {
      const { fetch, calls } = control({ "POST /v1/admin/changes": { change: planned } });
      const confirm = vi.fn(async () => true);
      await expect(runCliChange({ controlPlaneUrl: URL, accessToken: "t", change: { kind: "grant_project_access", project: "payments", developer: "U0NEW00001" }, cliVersion: "0.0.7", confirm, write: () => undefined }, fetch)).rejects.toThrow(/nothing was applied/);
      expect(confirm).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
    }
  });

  it("refuses an answer it cannot read, before asking", async () => {
    const { fetch } = control({ "POST /v1/admin/changes": { change: { changeId: CHANGE } } });
    const confirm = vi.fn(async () => true);
    await expect(runCliChange({ controlPlaneUrl: URL, accessToken: "t", change: { kind: "grant_project_access", project: "payments", developer: "U0NEW00001" }, cliVersion: "0.0.7", confirm, write: () => undefined }, fetch)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("declines, as cancelled, when the prompt is interrupted or cannot be asked, and applies nothing", async () => {
    const { fetch, calls } = control({ "POST /v1/admin/changes": { change: view("pending") }, [`POST /v1/admin/changes/${CHANGE}/decline`]: { change: view("declined") } });
    const lines: string[] = [];
    await expect(runCliChange({ controlPlaneUrl: URL, accessToken: "t", change: { kind: "grant_project_access", project: "payments", developer: "U0NEW00001" }, cliVersion: "0.0.7", confirm: () => Promise.reject(new Error("interrupted")), write: (line) => lines.push(line) }, fetch)).rejects.toThrow("interrupted");
    expect(calls.map((call) => call.path)).toEqual(["/v1/admin/changes", `/v1/admin/changes/${CHANGE}/decline`]);
    expect(calls[1]?.body).toMatchObject({ method: "cli", reason: "cancelled" });
    expect(lines.join("\n")).toContain("Nothing changed.");
  });

  it("keeps the broker's code when the apply is refused: expired, stale or a transient failure leaves nothing applied", async () => {
    for (const [status, code, message] of [
      [409, "CONFIRMATION_EXPIRED", `change ${CHANGE} expired at 2026-10-02T09:10:00.000Z; ask for the change again`],
      [409, "CHANGE_STALE", `what change ${CHANGE} was planned against has changed; ask for the change again`],
      [503, "RUNTIME_UNAVAILABLE", `change ${CHANGE} could not be applied just now; try again`],
    ] as const) {
      const { fetch, calls } = control({ "POST /v1/admin/changes": { change: view("pending") }, [`POST /v1/admin/changes/${CHANGE}/apply`]: refusal(status, code, message) });
      const lines: string[] = [];
      await expect(runCliChange({ controlPlaneUrl: URL, accessToken: "t", change: { kind: "grant_project_access", project: "payments", developer: "U0NEW00001" }, cliVersion: "0.0.7", confirm: async () => true, write: (line) => lines.push(line) }, fetch)).rejects.toMatchObject({ code, message: expect.stringContaining(CHANGE) as unknown });
      expect(calls).toHaveLength(2);
      expect(lines.join("\n")).not.toContain("Applied.");
    }
  });

  it("says nothing was applied when AgentX cannot be reached to apply", async () => {
    let call = 0;
    const fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) return Response.json({ change: view("pending") });
      throw new TypeError(`fetch failed for ${URL}`);
    }) as unknown as typeof globalThis.fetch;
    await expect(runCliChange({ controlPlaneUrl: URL, accessToken: "t", change: { kind: "grant_project_access", project: "payments", developer: "U0NEW00001" }, cliVersion: "0.0.7", confirm: async () => true, write: () => undefined }, fetch))
      .rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: expect.stringContaining("agentx admin changes") as unknown });
  });

  it("still ends declined when the decline cannot be recorded: nothing applies without a yes", async () => {
    const { fetch, calls } = control({ "POST /v1/admin/changes": { change: view("pending") }, [`POST /v1/admin/changes/${CHANGE}/decline`]: refusal(503, "RUNTIME_UNAVAILABLE", `change ${CHANGE} could not be declined just now; try again`) });
    const lines: string[] = [];
    const result = await runCliChange({ controlPlaneUrl: URL, accessToken: "t", change: { kind: "grant_project_access", project: "payments", developer: "U0NEW00001" }, cliVersion: "0.0.7", confirm: async () => false, write: (line) => lines.push(line) }, fetch);
    expect(result.outcome).toBe("declined");
    expect(calls.map((call) => call.path)).not.toContain(`/v1/admin/changes/${CHANGE}/apply`);
    expect(lines.join("\n")).toContain("Nothing was applied");
  });

  it("never shows the admin token, and strips terminal control characters from the effect", async () => {
    const token = "planted-admin-token-5f1c";
    const { fetch } = control({ "POST /v1/admin/changes": { change: { ...view("pending"), effect: "Grant \u001b[31mSlack\u001b[0m user U0NEW00001 access to project payments." } }, [`POST /v1/admin/changes/${CHANGE}/apply`]: refusal(403, "FORBIDDEN", "only the admin who asked for this change can confirm or decline it") });
    const lines: string[] = [];
    const error = await runCliChange({ controlPlaneUrl: URL, accessToken: token, change: { kind: "grant_project_access", project: "payments", developer: "U0NEW00001" }, cliVersion: "0.0.7", confirm: async (effect) => { lines.push(effect); return true; }, write: (line) => lines.push(line) }, fetch).catch((caught: unknown) => caught);
    expect(String((error as Error).message)).not.toContain(token);
    expect(lines.join("\n")).not.toContain(token);
    expect(lines.join("\n")).not.toContain("\u001b");
    expect(lines[0]).toBe("Grant [31mSlack[0m user U0NEW00001 access to project payments.");
  });
});

describe("exportChanges (FR-052)", () => {
  it("follows the cursor and writes one line per record, as JSON Lines with --json", async () => {
    const record = { changeId: CHANGE, kind: "bind_channel", traceId: "t", status: "applied", outcome: "confirmed", admin: { issuer: "i", subject: "admin-subject", displayName: "Ada" }, client: { cliVersion: "0.0.7" }, change: {}, effect: "Bind.", methodsOffered: ["cli"], proposedAt: "2026-10-02T09:00:00.000Z" };
    let page = 0;
    const fetch = vi.fn(async () => { page += 1; return Response.json(page === 1 ? { changes: [record], cursor: "next" } : { changes: [{ ...record, changeId: "66666666-6666-4666-8666-666666666666" }] }); }) as unknown as typeof globalThis.fetch;
    const json: string[] = [];
    expect(await exportChanges({ controlPlaneUrl: URL, accessToken: "t", since: "2026-10-01T00:00:00.000Z", write: (line) => { json.push(line); }, json: true }, fetch)).toEqual({ exported: 2, since: "2026-10-01T00:00:00.000Z" });
    expect(JSON.parse(json[0]!)).toMatchObject({ changeId: CHANGE });
    page = 0;
    const text: string[] = [];
    await exportChanges({ controlPlaneUrl: URL, accessToken: "t", since: "2026-10-01T00:00:00.000Z", write: (line) => { text.push(line); }, json: false }, fetch);
    expect(text[0]).toBe(`2026-10-02T09:00:00.000Z  confirmed  bind_channel  Ada  ${CHANGE}\n`);
  });

  it("asks for the window and each next page, and reads a newer record loosely (R1)", async () => {
    const record = { changeId: CHANGE, kind: "rename_everything", traceId: "t", status: "reviewing", admin: { issuer: "i", subject: "admin-subject", team: "x" }, client: { cliVersion: "0.9.0", os: "mac" }, change: { project: "payments" }, effect: "Something new.", methodsOffered: ["passkey"], proposedAt: "2026-10-02T09:00:00.000Z", newField: [1] };
    const pages = [{ changes: [record], cursor: "c1" }, { changes: [] }];
    const urls: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => { urls.push(input as string); return Response.json(pages.shift()); }) as unknown as typeof globalThis.fetch;
    const json: string[] = [];
    await exportChanges({ controlPlaneUrl: `${URL}/`, accessToken: "t", since: "2026-10-01T00:00:00.000Z", write: (line) => { json.push(line); }, json: true }, fetch);
    expect(urls[0]).toBe(`${URL}/v1/admin/changes?since=2026-10-01T00%3A00%3A00.000Z&limit=100`);
    expect(urls[1]).toBe(`${URL}/v1/admin/changes?since=2026-10-01T00%3A00%3A00.000Z&limit=100&cursor=c1`);
    expect(JSON.parse(json[0]!)).toEqual(record);
    const text: string[] = [];
    pages.push({ changes: [record] });
    await exportChanges({ controlPlaneUrl: URL, accessToken: "t", since: "2026-10-01T00:00:00.000Z", write: (line) => { text.push(line); }, json: false }, fetch);
    expect(text[0]).toBe(`2026-10-02T09:00:00.000Z  reviewing  rename_everything  admin-subject  ${CHANGE}\n`);
  });

  it("stops on a repeated cursor, refuses a page it cannot read, and keeps the broker's refusal", async () => {
    const repeating = vi.fn(async () => Response.json({ changes: [], cursor: "same" })) as unknown as typeof globalThis.fetch;
    await expect(exportChanges({ controlPlaneUrl: URL, accessToken: "t", since: "2026-10-01T00:00:00.000Z", write: () => undefined, json: true }, repeating)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    const invalid = vi.fn(async () => Response.json({ records: [] })) as unknown as typeof globalThis.fetch;
    await expect(exportChanges({ controlPlaneUrl: URL, accessToken: "t", since: "2026-10-01T00:00:00.000Z", write: () => undefined, json: true }, invalid)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    const refused = vi.fn(async () => refusal(403, "FORBIDDEN", "administrator claim is required")) as unknown as typeof globalThis.fetch;
    await expect(exportChanges({ controlPlaneUrl: URL, accessToken: "t", since: "2026-10-01T00:00:00.000Z", write: () => undefined, json: true }, refused)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("parseSince names what it exports (C18)", () => {
  it("keeps turn records' words by default, and names change records for admin changes", () => {
    const now = Date.parse("2026-09-24T12:00:00.000Z");
    expect(() => parseSince("31d", now)).toThrow("--since must be more than zero and at most 30d; turn records are kept 30 days");
    expect(() => parseSince("31d", now, "change records")).toThrow("--since must be more than zero and at most 30d; change records are kept 30 days");
    expect(parseSince("7d", now, "change records")).toBe("2026-09-17T12:00:00.000Z");
  });
});

describe("askToApply (Q6): the terminal prompt", () => {
  function terminal() {
    const input = new PassThrough();
    let shown = "";
    const output = new PassThrough();
    output.on("data", (chunk: Buffer) => { shown += chunk.toString(); });
    const signals = new EventEmitter();
    return { input, output, signals, shown: () => shown };
  }

  it("answers yes to y or yes, and no to n, no or an empty line", async () => {
    for (const [line, expected] of [["y", true], ["yes", true], ["Y", true], ["n", false], ["no", false], ["", false]] as const) {
      const io = terminal();
      const answer = askToApply("Apply this change?", io);
      io.input.write(`${line}\n`);
      expect(await answer).toBe(expected);
      expect(io.shown()).toContain("Apply this change? [y/N]");
    }
  });

  it("asks again after another answer", async () => {
    const io = terminal();
    const answer = askToApply("Apply this change?", io);
    io.input.write("maybe\n");
    await new Promise((resolve) => setImmediate(resolve));
    io.input.write("y\n");
    expect(await answer).toBe(true);
    expect(io.shown()).toContain("answer y or n");
  });

  it("is interrupted, never a yes, by Ctrl-C or the end of input", async () => {
    const interrupted = terminal();
    const first = askToApply("Apply this change?", interrupted);
    interrupted.signals.emit("SIGINT");
    await expect(first).rejects.toMatchObject({ code: "CONFIRMATION_DECLINED" });
    expect(interrupted.signals.listenerCount("SIGINT")).toBe(0);
    const ended = terminal();
    const second = askToApply("Apply this change?", ended);
    ended.input.end();
    await expect(second).rejects.toMatchObject({ code: "CONFIRMATION_DECLINED" });
  });
});

describe("the commands (E17)", () => {
  it("need --project and --developer, and a valid --since, before calling AgentX", async () => {
    const fetch = vi.fn();
    let stderr = "";
    const io = { fetchImplementation: fetch as unknown as typeof globalThis.fetch, stdout: { write: () => true }, stderr: { write: (text: string) => { stderr += text; return true; } } };
    expect(await executeCli(["admin", "project", "grant", "--developer", "U0NEW00001"], io)).not.toBe(0);
    expect(stderr).toContain("--project");
    expect(await executeCli(["admin", "project", "revoke", "--project", "payments"], io)).not.toBe(0);
    expect(stderr).toContain("--developer");
    expect(await executeCli(["admin", "changes", "--since", "45d"], io)).not.toBe(0);
    expect(stderr).toContain("--since must be more than zero and at most 30d");
    expect(fetch).not.toHaveBeenCalled();
  });

  const deployment = { controlPlaneUrl: "http://127.0.0.1:8787", auth: { issuer: "https://identity.example.test", clientId: "agentx-client", audience: "agentx-api" } };
  async function signedIn() {
    const directory = await mkdtemp(join(tmpdir(), "agentx-cli-changes-"));
    const deploymentFile = join(directory, "deployment.yaml");
    await writeFile(deploymentFile, JSON.stringify(deployment), "utf8");
    const tokens = new InMemoryTokenStore();
    await tokens.set(tokenStoreKey(deployment.auth), { accessToken: "access-secret-9d2e", expiresAt: Date.now() + 60_000 });
    let stdout = "";
    let stderr = "";
    return {
      globals: ["--config-dir", directory, "--deployment-file", deploymentFile, "--allow-loopback"],
      io: (fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) => ({ fetchImplementation: fetch, tokenStore: tokens, stdout: { write: (text: string) => { stdout += text; return true; } }, stderr: { write: (text: string) => { stderr += text; return true; } }, ...extra }),
      stdout: () => stdout,
      stderr: () => stderr,
    };
  }

  it("refuses a project name AgentX cannot hold, without echoing the developer", async () => {
    const session = await signedIn();
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    expect(await executeCli([...session.globals, "admin", "project", "grant", "--project", "Not A Name", "--developer", "someone@example.com"], session.io(fetch))).toBe(2);
    expect(session.stderr()).toContain("--project");
    expect(session.stderr()).not.toContain("someone@example.com");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("grant: shows the change, asks, and applies with the cli method; stdout carries the outcome", async () => {
    const session = await signedIn();
    const { fetch, calls } = control({ "POST /v1/admin/changes": { change: view("pending") }, [`POST /v1/admin/changes/${CHANGE}/apply`]: { change: view("applied") } });
    const confirm = vi.fn(async () => true);
    expect(await executeCli([...session.globals, "--json", "admin", "project", "grant", "--project", "payments", "--developer", "U0NEW00001"], session.io(fetch, { confirm }))).toBe(0);
    expect(confirm).toHaveBeenCalledWith("Apply this change?");
    expect(calls[0]?.body).toMatchObject({ change: { kind: "grant_project_access", project: "payments", developer: "U0NEW00001" }, methods: ["cli"] });
    expect(calls[1]).toMatchObject({ path: `/v1/admin/changes/${CHANGE}/apply`, body: { method: "cli" } });
    expect(JSON.parse(session.stdout())).toEqual({ ok: true, data: { outcome: "applied", changeId: CHANGE } });
    expect(session.stderr()).toContain("Grant Slack user U0NEW00001");
    expect(session.stderr()).toContain("Applied.");
    expect(`${session.stdout()}${session.stderr()}`).not.toContain("access-secret-9d2e");
  });

  it("revoke: a no declines with the cli method", async () => {
    const session = await signedIn();
    const { fetch, calls } = control({ "POST /v1/admin/changes": { change: { ...view("pending"), kind: "revoke_project_access" } }, [`POST /v1/admin/changes/${CHANGE}/decline`]: { change: view("declined") } });
    expect(await executeCli([...session.globals, "admin", "project", "revoke", "--project", "payments", "--developer", "U0NEW00001"], session.io(fetch, { confirm: async () => false }))).toBe(0);
    expect(calls[0]?.body).toMatchObject({ change: { kind: "revoke_project_access" } });
    expect(calls[1]).toMatchObject({ path: `/v1/admin/changes/${CHANGE}/decline`, body: { method: "cli", reason: "declined" } });
    expect(session.stdout()).toContain("declined");
  });

  it("--yes applies without asking, and still prints the change", async () => {
    const session = await signedIn();
    const { fetch, calls } = control({ "POST /v1/admin/changes": { change: view("pending") }, [`POST /v1/admin/changes/${CHANGE}/apply`]: { change: view("applied") } });
    const confirm = vi.fn(async () => false);
    expect(await executeCli([...session.globals, "admin", "project", "grant", "--project", "payments", "--developer", "U0NEW00001", "--yes"], session.io(fetch, { confirm }))).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(calls[1]).toMatchObject({ path: `/v1/admin/changes/${CHANGE}/apply`, body: { method: "cli" } });
    expect(session.stderr()).toContain("Grant Slack user U0NEW00001");
  });

  it("without --yes and without a terminal, refuses before planning anything", async () => {
    const session = await signedIn();
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const tty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
    try {
      expect(await executeCli([...session.globals, "admin", "project", "grant", "--project", "payments", "--developer", "U0NEW00001"], session.io(fetch))).toBe(2);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: tty, configurable: true });
    }
    expect(session.stderr()).toContain("pass --yes");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("admin changes writes JSON Lines to stdout with --json, and the count to stderr", async () => {
    const session = await signedIn();
    const record = { changeId: CHANGE, kind: "bind_channel", traceId: "t", status: "applied", outcome: "confirmed", admin: { issuer: "i", subject: "admin-subject" }, client: { cliVersion: "0.0.7" }, change: {}, effect: "Bind.", methodsOffered: ["cli"], proposedAt: "2026-10-02T09:00:00.000Z" };
    const urls: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => { urls.push(input as string); return Response.json({ changes: [record] }); }) as unknown as typeof globalThis.fetch;
    expect(await executeCli([...session.globals, "--json", "admin", "changes", "--since", "7d"], session.io(fetch))).toBe(0);
    expect(urls[0]).toContain("/v1/admin/changes?since=");
    expect(session.stdout().trim().split("\n").map((line) => JSON.parse(line) as unknown)).toEqual([record]);
    expect(session.stderr()).toContain("1 change record");
  });
});
