// Spec 062 FR-051: `agentx adapter …` registers adapters, binds their spaces and removes links, as an administrator.
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeCli } from "../../packages/cli/src/main.js";
import type { SetupCommandContext, SetupRun } from "../../packages/cli/src/setup/command-context.js";
import { memoryInitSecrets, scriptedPrompter, T0 } from "../support/init-fakes.js";
import { STAGING_SETTINGS, setupServices } from "../support/setup-fakes.js";

const SECRET = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const adapter = {
  channel: "whatsapp", callbackUrl: "https://adapter.example.com/rovara",
  capabilities: { threads: false, buttons: 3, edits: false, maxTextLength: 4096, proactive: false },
  projects: ["web", "billing"], stepUp: ["admin"], secretName: "agentx/staging/channel-adapter/whatsapp",
  createdAt: "2026-11-08T10:00:00.000Z", updatedAt: "2026-11-08T10:00:00.000Z", updatedBy: "admin",
};

let directory: string | undefined;
afterEach(async () => { if (directory !== undefined) await rm(directory, { recursive: true, force: true }); directory = undefined; });

function harness(answer: (method: string, path: string) => { status: number; body: unknown } = () => ({ status: 200, body: { adapter, signingSecret: SECRET } })) {
  const requests: Array<{ method: string; path: string; body?: unknown; token: string | undefined }> = [];
  const lines: string[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    const method = init?.method ?? "GET";
    const path = `${parsed.pathname}${parsed.search}`;
    requests.push({ method, path, ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}), token: (init?.headers as Record<string, string>).authorization });
    const { status, body } = answer(method, path);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const run = (): SetupRun => ({
    env: "staging", settings: STAGING_SETTINGS, session: { controlPlaneUrl: "https://api.example.com", accessToken: "admin-token" }, secrets: memoryInitSecrets(),
    services: setupServices({ fetch: fetchFn }), prompter: scriptedPrompter([]), write: (line) => { lines.push(line); },
    now: () => T0, sleep: async () => undefined, print: (_result, text) => { lines.push(text); },
  });
  const context: SetupCommandContext = { open: async () => run(), openAws: async () => run() };
  const cli = async (...args: string[]) => {
    const stderr: string[] = [];
    const code = await executeCli([...args, "--env", "staging"], { setup: context, stdout: { write: () => undefined }, stderr: { write: (text: string) => stderr.push(text) } });
    return { code, stderr: stderr.join("") };
  };
  return { cli, requests, lines };
}

describe("agentx adapter add", () => {
  it("registers the adapter with its capabilities, projects and step-up, and prints the new secret once", async () => {
    const { cli, requests, lines } = harness();
    const result = await cli("adapter", "add", "whatsapp", "--callback-url", "https://adapter.example.com/rovara", "--projects", "web,billing", "--buttons", "3", "--step-up", "admin");
    expect(result).toEqual({ code: 0, stderr: "" });
    expect(requests).toEqual([{
      method: "PUT", path: "/v1/admin/channels/whatsapp", token: "Bearer admin-token",
      body: {
        callbackUrl: "https://adapter.example.com/rovara",
        capabilities: { threads: false, buttons: 3, edits: false, maxTextLength: 4096, proactive: false },
        projects: ["web", "billing"], stepUp: ["admin"],
      },
    }]);
    expect(lines.join("")).toContain(`Signing secret (shown once; give it to the adapter, Rovara does not show it again):\n${SECRET}\n`);
  });

  it("writes the secret to a private file instead, and asks for a rotation with --rotate", async () => {
    directory = await mkdtemp(join(tmpdir(), "adapter-cli-"));
    const file = join(directory, "whatsapp.secret");
    const { cli, requests, lines } = harness();
    expect((await cli("adapter", "add", "whatsapp", "--callback-url", "https://adapter.example.com/rovara", "--projects", "web", "--rotate", "--secret-file", file)).code).toBe(0);
    expect(requests[0]?.path).toBe("/v1/admin/channels/whatsapp?rotate=true");
    expect((requests[0]?.body as { stepUp: string[] }).stepUp).toEqual(["plan_approval", "admin"]);
    expect(await readFile(file, "utf8")).toBe(`${SECRET}\n`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(lines.join("")).not.toContain(SECRET);
  });

  it("says the secret is unchanged when the broker made none", async () => {
    const { cli, lines } = harness(() => ({ status: 200, body: { adapter } }));
    await cli("adapter", "add", "whatsapp", "--callback-url", "https://adapter.example.com/rovara", "--projects", "web");
    expect(lines.join("")).toContain("The signing secret is unchanged.");
  });

  it.each([
    ["an unknown step-up kind", ["--step-up", "everything"], "--step-up must be plan_approval, admin, both separated by a comma, or none"],
    ["a bad project name", ["--projects", "Web App"], "--projects Web App is not a project name"],
    ["too many buttons", ["--buttons", "11"], "--buttons must be a whole number from 0 to 10"],
  ])("refuses %s before calling the control plane", async (_name, extra, message) => {
    const { cli, requests } = harness();
    const args = ["adapter", "add", "whatsapp", "--callback-url", "https://adapter.example.com/rovara", "--projects", "web", ...extra];
    const result = await cli(...args);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(requests).toEqual([]);
  });

  it("says how to enable channel adapters when the environment has them off", async () => {
    const { cli } = harness(() => ({ status: 404, body: { error: { code: "NOT_FOUND", message: "channel adapters are not enabled in this deployment" } } }));
    const result = await cli("adapter", "list");
    expect(result.stderr).toContain("deploy it with the ChannelAdapters parameter set to enabled");
  });
});

describe("binding, unbinding, unlinking and removing", () => {
  it("binds a space to the global --project, with the IDs encoded in the path", async () => {
    const { cli, requests, lines } = harness(() => ({ status: 200, body: { binding: {} } }));
    expect((await cli("adapter", "bind", "whatsapp", "--tenant", "+14155550100", "--space", "group=AbC-12_x", "--project", "web")).code).toBe(0);
    expect(requests).toEqual([{ method: "PUT", path: "/v1/admin/channels/whatsapp/bindings/%2B14155550100/group%3DAbC-12_x", body: { projectName: "web" }, token: "Bearer admin-token" }]);
    expect(lines.join("")).toContain("Bound whatsapp space group=AbC-12_x to web.");
  });

  it("unbinds, unlinks a user, lists and removes through the admin routes", async () => {
    const { cli, requests } = harness((method, path) => ({ status: 200, body: method === "GET" && path === "/v1/admin/channels" ? { adapters: [adapter] } : { deleted: true } }));
    await cli("adapter", "unbind", "whatsapp", "--tenant", "+14155550100", "--space", "group=AbC-12_x");
    await cli("adapter", "unlink", "whatsapp", "--tenant", "+14155550100", "--user", "+919876544821");
    await cli("adapter", "list");
    await cli("adapter", "remove", "whatsapp");
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "DELETE /v1/admin/channels/whatsapp/bindings/%2B14155550100/group%3DAbC-12_x",
      "DELETE /v1/admin/channel-links/whatsapp/%2B14155550100/%2B919876544821",
      "GET /v1/admin/channels",
      "DELETE /v1/admin/channels/whatsapp",
    ]);
  });

  it("refuses an ID with a slash, and slack, which has its own commands", async () => {
    const { cli, requests } = harness();
    expect((await cli("adapter", "bind", "whatsapp", "--tenant", "a/b", "--space", "s", "--project", "web")).stderr).toContain("--tenant must be 1–128 characters");
    expect((await cli("adapter", "remove", "slack")).code).not.toBe(0);
    expect(requests).toEqual([]);
  });
});
