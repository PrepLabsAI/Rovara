// Spec 041: `agentx workspaces` -- the loopback page that shows a developer's projects and the
// workspaces in them, its refusals, and the text it prints when there is no browser.
import { request as httpRequest } from "node:http";
import { transformSync } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentXError } from "@agentx/contracts";
import { WORKSPACES_JS, workspacesHtml } from "../../packages/cli/src/workspaces-ui/page.js";
import { workspaceState, workspacesText, type DeveloperWorkspacesResult } from "../../packages/cli/src/developer/workspaces.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { runWorkspacesCommand, uiData } from "../../packages/cli/src/workspaces-ui/index.js";
import { startWorkspacesUiServer, type WorkspacesUiServer } from "../../packages/cli/src/workspaces-ui/server.js";
import { UI_TOKEN_HEADER, UI_TOKEN_QUERY, type UiData, type UiDataReply } from "../../packages/cli/src/workspaces-ui/protocol.js";

const TOKEN = "test-session-token";
const uuid = (tag: string) => `00000000-0000-4000-8000-0000000000${tag}`;

const result: DeveloperWorkspacesResult = {
  env: "staging",
  url: "https://abc123.execute-api.us-east-1.amazonaws.com",
  workspaces: {
    developer: { id: "a".repeat(64), name: "Maya Chen", provider: "slack", slackUserId: "U0MAYA001" },
    projects: [
      { name: "payments-api", latestRevision: 7, access: "channel", channels: [{ channelId: "C0PAY0001" }] },
      { name: "solo", latestRevision: 1, access: "granted", channels: [] },
    ],
    workspaces: [
      { id: uuid("02"), projectName: "payments-api", projectRevision: 7, status: "BUSY", busy: true, createdAt: "2026-09-26T09:00:00.000Z", updatedAt: "2026-09-26T10:00:00.000Z" },
      { id: uuid("01"), projectName: "payments-api", projectRevision: 6, status: "READY", busy: false, createdAt: "2026-09-20T09:00:00.000Z", updatedAt: "2026-09-21T09:00:00.000Z" },
    ],
    notices: [],
  },
};

const servers: WorkspacesUiServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  vi.restoreAllMocks();
});

async function serve(read: () => Promise<UiData> = async () => uiData(result, "2026-09-28T00:00:00.000Z")): Promise<WorkspacesUiServer> {
  const server = await startWorkspacesUiServer({ read, token: TOKEN });
  servers.push(server);
  return server;
}

/** A request the page itself would make: same-origin, with the session token in its header. */
const get = (server: WorkspacesUiServer, path: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${server.port}${path}`, {
    headers: { origin: `http://127.0.0.1:${server.port}`, "sec-fetch-site": "same-origin", [UI_TOKEN_HEADER]: TOKEN, ...headers },
  });

describe("the workspaces page's server (FR-010, FR-011, FR-012)", () => {
  it("serves the page, its stylesheet and its module from the loopback address only", async () => {
    const server = await serve();
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/?${UI_TOKEN_QUERY}=${TOKEN}`);

    const page = await get(server, `/?${UI_TOKEN_QUERY}=${TOKEN}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("access-control-allow-origin")).toBeNull();
    const html = await page.text();
    expect(html).toContain(`/app.js?${UI_TOKEN_QUERY}=${TOKEN}`);
    // No inline script or style, so the CSP above holds.
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
    expect(html).not.toContain("<style");

    expect((await get(server, "/app.css")).headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect((await get(server, "/app.js")).headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect((await get(server, "/nothing")).status).toBe(404);
  });

  it("refuses a request without the session token", async () => {
    const server = await serve();
    const response = await fetch(`http://127.0.0.1:${server.port}/data`);
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("session token");
  });

  it.each([
    ["a cross-site request", { "sec-fetch-site": "cross-site" }, 403],
    ["another loopback port as a same-site origin", { "sec-fetch-site": "same-site" }, 403],
    ["another origin", { origin: "http://evil.test" }, 403],
    ["another page as referer", { referer: "http://evil.test/x" }, 403],
    ["a wrong token", { [UI_TOKEN_HEADER]: "not-the-token" }, 401],
  ])("refuses %s", async (_name, headers, status) => {
    const server = await serve();
    expect((await get(server, "/data", headers)).status).toBe(status);
  });

  // `fetch` will not send a Host header of its own choosing, so this one goes over a raw request:
  // a name that resolves to 127.0.0.1 must not be able to rebind onto the listener.
  it("refuses a Host that is not this listener", async () => {
    const server = await serve();
    const status = await new Promise<number>((resolvePromise, reject) => {
      const request = httpRequest({
        host: "127.0.0.1", port: server.port, path: "/data", method: "GET",
        headers: { host: "agentx.test", [UI_TOKEN_HEADER]: TOKEN },
      }, (response) => { response.resume(); resolvePromise(response.statusCode ?? 0); });
      request.on("error", reject);
      request.end();
    });
    expect(status).toBe(403);
  });

  it("answers /data with the list, and with the sign-in to run when the control plane refuses", async () => {
    const server = await serve();
    const reply = await (await get(server, "/data")).json() as UiDataReply;
    expect(reply.ok).toBe(true);
    expect(reply.ok && reply.data.workspaces.map((workspace) => [workspace.id, workspace.state])).toEqual([
      [uuid("02"), "working"],
      [uuid("01"), "ready"],
    ]);

    const refusing = await serve(async () => { throw agentXError("AUTH_REQUIRED", "your AgentX sign-in for staging has ended; run agentx login <url>"); });
    const refusal = await (await get(refusing, "/data")).json() as UiDataReply;
    expect(refusal).toEqual({ ok: false, error: "your AgentX sign-in for staging has ended; run agentx login <url>" });
  });

  it("does not repeat an unexpected failure back to the page", async () => {
    const server = await serve(async () => { throw new Error("connect ECONNREFUSED 10.0.0.1:443"); });
    const reply = await (await get(server, "/data")).json() as UiDataReply;
    expect(reply).toEqual({ ok: false, error: "AgentX could not be read; check the terminal" });
  });
});

describe("the page's module", () => {
  it("is a valid ES module", () => {
    // It is served as text and never compiled with the rest of the CLI, so nothing else would
    // catch a syntax error in it before a browser did.
    expect(() => transformSync(WORKSPACES_JS, { loader: "js", format: "esm" })).not.toThrow();
  });

  it("addresses only elements the page has", () => {
    const html = workspacesHtml(TOKEN);
    const addressed = [...WORKSPACES_JS.matchAll(/byId\("([^"]+)"\)/g)].map((match) => match[1]!);
    expect(addressed.length).toBeGreaterThan(5);
    for (const id of new Set(addressed)) expect(html).toContain(`id="${id}"`);
  });
});

describe("what the command shows (FR-020, FR-021)", () => {
  it("maps each workspace status to a word a developer reads", () => {
    const of = (status: string, busy = false) => workspaceState({ id: uuid("01"), projectName: "p", projectRevision: 1, status: status as "READY", busy, createdAt: "x", updatedAt: "x" });
    expect([of("READY"), of("READY", true), of("PREPARING"), of("UNPREPARED"), of("STOPPED"), of("CLOSED"), of("PREPARATION_FAILED")])
      .toEqual(["ready", "working", "starting", "not started", "stopped", "closed", "failed to start"]);
  });

  it("prints every project with the workspaces in it", () => {
    const text = workspacesText(result);
    expect(text).toContain("AgentX environment staging");
    expect(text).toContain("payments-api  (revision 7, 2 workspaces)");
    expect(text).toContain(`  ${uuid("02")}  working`);
    expect(text).toContain("solo  (revision 1, 0 workspaces)");
    expect(text).toContain("no workspaces yet");
  });

  it("reads the control plane once before the browser opens, and seeds the page from that read", async () => {
    const read = vi.fn(async () => result);
    let url = "";
    let server: { port: number } | undefined;
    await runWorkspacesCommand({
      read, ui: true, json: false,
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      openBrowser: async (opened) => {
        url = opened;
        server = { port: Number(new URL(opened).port) };
      },
      waitForExit: async () => {
        const token = new URL(url).searchParams.get(UI_TOKEN_QUERY) ?? "";
        const origin = `http://127.0.0.1:${server!.port}`;
        const first = await (await fetch(`${origin}/data`, { headers: { origin, [UI_TOKEN_HEADER]: token } })).json() as UiDataReply;
        expect(first.ok && first.data.env).toBe("staging");
        expect(read).toHaveBeenCalledTimes(1); // the page's first request is answered from the first read
        const second = await (await fetch(`${origin}/data`, { headers: { origin, [UI_TOKEN_HEADER]: token } })).json() as UiDataReply;
        expect(second.ok).toBe(true);
        expect(read).toHaveBeenCalledTimes(2); // a refresh reads the control plane again
      },
    });
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=/);
  });

  it("stops serving when the command ends", async () => {
    let origin = "";
    let token = "";
    await runWorkspacesCommand({
      read: async () => result, ui: true, json: false,
      stdout: { write: () => undefined }, stderr: { write: () => undefined },
      waitForExit: async () => undefined,
      openBrowser: async (opened) => {
        origin = new URL(opened).origin;
        token = new URL(opened).searchParams.get(UI_TOKEN_QUERY) ?? "";
      },
    });
    await expect(fetch(`${origin}/data`, { headers: { origin, [UI_TOKEN_HEADER]: token } })).rejects.toThrow();
  });
});

describe("agentx workspaces", () => {
  const cli = async (argv: string[], overrides: Record<string, unknown> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await executeCli(argv, {
      stdout: { write: (text: string) => out.push(text) },
      stderr: { write: (text: string) => err.push(text) },
      workspaces: { read: async () => result, isInteractive: () => false, ...overrides },
    });
    return { code, out: out.join(""), err: err.join("") };
  };

  it("prints the list without a browser when there is no terminal", async () => {
    const { code, out } = await cli(["workspaces"]);
    expect(code).toBe(0);
    expect(out).toContain("payments-api  (revision 7, 2 workspaces)");
  });

  it("prints the list rather than opening a browser with --no-ui", async () => {
    const openBrowser = vi.fn(async () => undefined);
    const { out } = await cli(["workspaces", "--no-ui"], { isInteractive: () => true, openBrowser });
    expect(openBrowser).not.toHaveBeenCalled();
    expect(out).toContain(uuid("02"));
  });

  it("answers --json with the control plane's own shape, and never opens a browser", async () => {
    const openBrowser = vi.fn(async () => undefined);
    const { out } = await cli(["workspaces", "--json"], { isInteractive: () => true, openBrowser });
    expect(openBrowser).not.toHaveBeenCalled();
    const parsed = JSON.parse(out) as { env: string; workspaces: Array<{ id: string }> };
    expect(parsed.env).toBe("staging");
    expect(parsed.workspaces.map((workspace) => workspace.id)).toEqual([uuid("02"), uuid("01")]);
  });

  it("opens the page and names its address in the terminal when a browser is there", async () => {
    const opened: string[] = [];
    const { err } = await cli(["workspaces"], {
      isInteractive: () => true,
      openBrowser: async (url: string) => { opened.push(url); },
      waitForExit: async () => undefined,
    });
    expect(opened).toHaveLength(1);
    expect(err).toContain(opened[0]!);
    expect(err).toContain("Ctrl-C");
  });

  it("reports a sign-in that has ended in the terminal rather than opening a page", async () => {
    const openBrowser = vi.fn(async () => undefined);
    const { code, err } = await cli(["workspaces"], {
      isInteractive: () => true,
      openBrowser,
      waitForExit: async () => undefined,
      read: async () => { throw agentXError("AUTH_REQUIRED", "your AgentX sign-in for staging has ended; run agentx login <url>"); },
    });
    expect(code).not.toBe(0);
    expect(openBrowser).not.toHaveBeenCalled();
    expect(err).toContain("run agentx login");
  });
});
