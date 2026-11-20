// Exercise the real browser handlers without binding a loopback socket.
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { createCallbackListener } from "../../packages/cli/src/auth.js";
import { listenForChatGptCallback } from "../../packages/cli/src/developer/chatgpt.js";
import { authorizeCredential } from "../../packages/cli/src/admin/authorize.js";
import { githubAppManifest, manifestFormPage, startManifestListener } from "../../packages/cli/src/init/github-app.js";
import { wizardHtml, WIZARD_JS } from "../../packages/cli/src/init/ui/page.js";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;
const wire = vi.hoisted(() => ({ handler: undefined as Handler | undefined }));
vi.mock("node:http", async () => {
  const { EventEmitter } = await import("node:events");
  return { createServer: (handler: Handler) => {
    wire.handler = handler;
    return Object.assign(new EventEmitter(), {
      listen: (_port: number, _host: string, ready: () => void) => { ready(); },
      address: () => ({ port: 41234 }),
      close: () => undefined,
      closeAllConnections: () => undefined,
    });
  } };
});

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach((close) => { close(); }); });
function request(query: Record<string, string>, path = "/callback", checkCopy = true): { status: number; body: string } {
  const result = { status: 0, body: "" };
  const response = {
    writeHead(status: number) { result.status = status; return this; },
    end(body = "") { result.body = body; return this; },
  };
  wire.handler!({ method: "GET", headers: { host: "127.0.0.1:41234" }, url: `${path}?${new URLSearchParams(query).toString()}` } as IncomingMessage, response as unknown as ServerResponse);
  if (checkCopy) expect(result.body).not.toMatch(/agentx|terminal|\bCLI\b|\bnpx\b|\bcommand\b/iu);
  return result;
}

it.each(["access_denied", "temporarily_unavailable"])("keeps shared sign-in browser refusals plain (%s)", async (error) => {
  const listener = await createCallbackListener("expected", 60_000, 41234);
  cleanup.push(() => listener.close());
  const response = request({ state: "expected", error, error_description: "AgentX: return to the terminal; run agentx login PROVIDER-CANARY" });
  expect(response.status).toBe(200);
  expect(response.body).toContain("Rovara sign-in did not finish");
  expect(response.body).not.toContain("PROVIDER-CANARY");
  await expect(listener.code).rejects.toMatchObject({ code: error === "access_denied" ? "AUTH_REQUIRED" : "RUNTIME_UNAVAILABLE" });
});

it.each(["success", "refusal", "missing-code"])("keeps credential browser callbacks plain (%s) and ignores wrong state", async (kind) => {
  const secrets = { read: vi.fn(async () => JSON.stringify({ clientId: "client", clientSecret: "secret" })), write: vi.fn(async () => undefined), tag: vi.fn(async () => undefined) };
  const fetchImplementation = vi.fn<typeof fetch>(async (url) => (typeof url === "string" ? url : url instanceof URL ? url.href : url.url).includes("oauth_token")
    ? Response.json({ refresh_token: "refresh" })
    : Response.json({ credential: { ref: "asana-bot", type: "oauth-refresh-token", builtIn: false, tokenCached: false }, replaced: false }, { status: 201 }));
  const pages: Array<{ status: number; body: string }> = [];
  const result = authorizeCredential({
    controlPlaneUrl: "https://rovara.example", accessToken: "token", ref: "asana-bot", secretName: "agentx/connectors/asana-bot", provider: "asana", secrets, fetchImplementation,
    showUrl: () => undefined,
    openBrowser: async (address) => {
      const state = new URL(address).searchParams.get("state")!;
      pages.push(request({ state: "wrong", code: "untrusted" }, "/callback", false));
      pages.push(request(kind === "success" ? { state, code: "accepted" } : kind === "refusal" ? { state, error: "access_denied" } : { state }, "/callback", false));
      pages.push(request({ state, code: "replayed" }, "/callback", false));
    },
  });
  if (kind === "success") { await result; expect(secrets.write).toHaveBeenCalledTimes(1); expect(fetchImplementation).toHaveBeenCalledTimes(2); }
  else { await expect(result).rejects.toMatchObject({ code: "AUTH_REQUIRED" }); expect(secrets.write).not.toHaveBeenCalled(); expect(fetchImplementation).not.toHaveBeenCalled(); }
  expect(pages.map((page) => page.status)).toEqual([400, 200, 410]);
  for (const page of pages) expect(page.body).not.toMatch(/agentx|terminal|\bCLI\b|\bnpx\b|\bcommand\b/iu);
});

it("keeps the legacy GitHub browser pages plain while preserving state and missing-code checks", async () => {
  const listener = await startManifestListener({ state: "expected", page: () => "<p>Setup</p>", timeoutMs: 60_000 });
  cleanup.push(() => listener.close());
  expect(request({ state: "wrong", code: "untrusted" }, "/github/created").status).toBe(400);
  expect(request({ state: "expected" }, "/github/created").status).toBe(400);
  expect(request({ state: "expected", code: "accepted" }, "/github/created").status).toBe(200);
  await expect(listener.code).resolves.toBe("accepted");
  expect(manifestFormPage({ actionUrl: "https://github.com", manifest: githubAppManifest({ appName: "Rovara", redirectUrl: listener.redirectUrl, webhookUrl: "https://rovara.example/webhook" }) })).not.toMatch(/agentx|terminal|\bcommand\b/iu);
});

it("uses Rovara in the installer shell and gives browser recovery on connection loss", () => {
  expect(wizardHtml("token")).toContain("<title>Install Rovara</title>");
  expect(wizardHtml("token")).not.toMatch(/agentx/iu);
  expect(WIZARD_JS).toContain("Lost the connection to the installer. Refresh this page to reconnect.");
  expect(WIZARD_JS).not.toMatch(/in a terminal|run the command/iu);
});

it("keeps shared sign-in completion and invalid callbacks plain and preserves state checks", async () => {
  const listener = await createCallbackListener("expected", 60_000, 41234);
  cleanup.push(() => listener.close());
  expect(request({ state: "wrong", code: "untrusted" }).status).toBe(400);
  expect(request({ state: "expected", code: "accepted" })).toMatchObject({ status: 200, body: "Rovara sign-in complete. You can close this window." });
  await expect(listener.code).resolves.toBe("accepted");
});

it("keeps shared sign-in missing-code failures plain", async () => {
  const listener = await createCallbackListener("expected", 60_000, 41234);
  cleanup.push(() => listener.close());
  expect(request({ state: "expected" }).status).toBe(400);
  await expect(listener.code).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
});

it.each(["success", "refusal", "missing-code"])("keeps ChatGPT browser callbacks plain (%s)", async (kind) => {
  const listener = await listenForChatGptCallback("expected", 41234);
  cleanup.push(listener!.close);
  expect(request({ state: "wrong", code: "untrusted", client_id: "client" }, "/auth/callback").status).toBe(400);
  const query: Record<string, string> = kind === "success" ? { state: "expected", code: "accepted", client_id: "client" }
    : kind === "refusal" ? { state: "expected", error: "access_denied" } : { state: "expected" };
  const response = request(query, "/auth/callback");
  expect(response.status).toBe(kind === "success" ? 200 : 400);
  if (kind === "success") {
    expect(response.body).toContain("<title>Rovara</title>");
    await expect(listener!.values).resolves.toEqual({ state: "expected", code: "accepted", clientId: "client" });
  } else await expect(listener!.values).rejects.toMatchObject({ code: "CONFIG_INVALID" });
});
