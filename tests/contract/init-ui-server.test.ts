import { afterEach, describe, expect, it } from "vitest";
import { browserPrompter } from "../../packages/cli/src/init/ui/prompter.js";
import { WIZARD_TOKEN_HEADER, WIZARD_TOKEN_QUERY, type WizardSnapshot } from "../../packages/cli/src/init/ui/protocol.js";
import { startWizardServer, type WizardServer } from "../../packages/cli/src/init/ui/server.js";
import { createWizardHub, type WizardHub } from "../../packages/cli/src/init/ui/state.js";

const TOKEN = "test-session-token-aaaaaaaaaaaaaaaaaaa";

const open: WizardServer[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((server) => server.close())); });

async function wizard(): Promise<{ hub: WizardHub; server: WizardServer; origin: string; get: typeof request; post: typeof postAnswer }> {
  const hub = createWizardHub("staging");
  const server = await startWizardServer({ hub, token: TOKEN });
  open.push(server);
  const origin = `http://127.0.0.1:${server.port}`;
  return { hub, server, origin, get: request, post: postAnswer };
}

const request = (origin: string, path: string, headers: Record<string, string> = {}) =>
  fetch(`${origin}${path}`, { headers: { [WIZARD_TOKEN_HEADER]: TOKEN, ...headers } });

const postAnswer = (origin: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${origin}/answer`, {
    method: "POST",
    headers: { [WIZARD_TOKEN_HEADER]: TOKEN, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("the install wizard's server", () => {

  it("serves the page, its stylesheet, its module and the state, and nothing else", async () => {
    const { origin } = await wizard();
    const page = await request(origin, "/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await page.text();
    expect(html).toContain(`/app.js?${WIZARD_TOKEN_QUERY}=${TOKEN}`);
    // No inline script: the page's only code is the module, so the CSP below can stay strict.
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);

    expect((await request(origin, "/app.css")).headers.get("content-type")).toBe("text/css; charset=utf-8");
    const module = await request(origin, "/app.js");
    expect(module.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await module.text()).toContain("EventSource");

    const state = (await (await request(origin, "/state")).json()) as WizardSnapshot;
    expect(state).toMatchObject({ env: "staging", phase: "running", steps: [], log: [] });

    expect((await request(origin, "/../etc/passwd")).status).toBe(404);
    expect((await request(origin, "/answer")).status).toBe(404);
  });

  it("FR-011: refuses a foreign Origin, a foreign Referer and a cross-site Sec-Fetch-Site", async () => {
    const { origin } = await wizard();
    expect((await request(origin, "/state", { origin: "http://evil.example" })).status).toBe(403);
    expect((await postAnswer(origin, { id: "x", value: "y" }, { origin: "http://evil.example" })).status).toBe(403);
    // Another loopback port is a different origin, and "same-site" for an IP address.
    expect((await request(origin, "/state", { origin: "http://127.0.0.1:1" })).status).toBe(403);
    expect((await request(origin, "/state", { referer: "http://evil.example/page" })).status).toBe(403);
    expect((await request(origin, "/state", { referer: "not a url" })).status).toBe(403);
    for (const site of ["cross-site", "same-site"]) {
      expect((await request(origin, "/state", { "sec-fetch-site": site })).status).toBe(403);
    }
    // What the wizard's own page and the browser that opened it actually send.
    expect((await request(origin, "/state", { origin, referer: `${origin}/`, "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await request(origin, "/", { "sec-fetch-site": "none" })).status).toBe(200);
  });

  it("refuses an answer that is stale, unreadable or too large, and never fails the run over it", async () => {
    const { hub, origin } = await wizard();
    const prompter = browserPrompter(hub);
    const answer = prompter.ask("Alert email address", { flag: "--alert-email", validate: (value) => (value.includes("@") ? undefined : "that is not an email address") });
    const first = hub.state().question?.id;

    const rejected = await postAnswer(origin, { id: first, value: "nope" });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ ok: false, error: "that is not an email address" });

    expect(await (await postAnswer(origin, { id: first, value: "ops@example.com" })).json())
      .toEqual({ ok: false, error: "that question is out of date; answer the one shown above" });
    expect(await (await postAnswer(origin, "{not json")).json()).toEqual({ ok: false, error: "that answer could not be read" });
    expect(await (await postAnswer(origin, { id: 7, value: null })).json()).toEqual({ ok: false, error: "that answer could not be read" });
    expect(await (await postAnswer(origin, { id: hub.state().question?.id, value: "x".repeat(70 * 1024) })).json())
      .toEqual({ ok: false, error: "that answer is too large" });

    // The run is still waiting, and still takes a good answer.
    expect(await (await postAnswer(origin, { id: hub.state().question?.id, value: "ops@example.com" })).json()).toEqual({ ok: true });
    await expect(answer).resolves.toBe("ops@example.com");
  });

  it("POST /close tells the hub the page asked to close, behind the same checks as every route", async () => {
    const { hub, origin } = await wizard();
    let asked = false;
    void hub.closeRequested().then(() => { asked = true; });
    const refused = await fetch(`${origin}/close`, { method: "POST" });
    expect(refused.status).toBe(401);
    const accepted = await fetch(`${origin}/close`, { method: "POST", headers: { [WIZARD_TOKEN_HEADER]: TOKEN } });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true });
    await hub.closeRequested();
    expect(asked).toBe(true);
  });

});
