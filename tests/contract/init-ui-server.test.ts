// SC-002: the wizard server at the HTTP level -- its routes, the session-token refusal, the
// Origin, Referer and Sec-Fetch-Site refusals, and that it listens on the loopback address and
// nothing else. Every request here is real HTTP against a real listener on 127.0.0.1.
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { browserPrompter } from "../../packages/cli/src/init/ui/prompter.js";
import { WIZARD_TOKEN_HEADER, WIZARD_TOKEN_QUERY, type AnswerReply, type WizardSnapshot } from "../../packages/cli/src/init/ui/protocol.js";
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

/** This machine's first non-loopback IPv4 address, when it has one. */
function externalAddress(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return undefined;
}

describe("the install wizard's server", () => {
  it("listens on 127.0.0.1 and on no other address this machine has", async () => {
    const { server, origin } = await wizard();
    expect(server.url.startsWith(`${origin}/?${WIZARD_TOKEN_QUERY}=`)).toBe(true);
    await expect(request(origin, "/state")).resolves.toMatchObject({ status: 200 });

    const external = externalAddress();
    if (external === undefined) return; // an isolated runner with only a loopback interface
    const refused = await new Promise<string>((resolvePromise) => {
      const socket = connect({ host: external, port: server.port });
      socket.setTimeout(2_000);
      socket.on("connect", () => { socket.destroy(); resolvePromise("connected"); });
      socket.on("timeout", () => { socket.destroy(); resolvePromise("timed out"); });
      socket.on("error", () => resolvePromise("refused"));
    });
    expect(refused).not.toBe("connected");
  });

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

  it("every element the page's module looks up is in the page, and the module needs no inline code", async () => {
    const { origin } = await wizard();
    const html = await (await request(origin, "/")).text();
    const module = await (await request(origin, "/app.js")).text();
    const wanted = [...module.matchAll(/byId\("([a-z-]+)"\)|show\("([a-z-]+)"/g)].map((match) => match[1] ?? match[2]);
    expect(wanted.length).toBeGreaterThan(8);
    for (const id of new Set(wanted)) expect(html).toContain(`id="${id}"`);
    // The CSP forbids 'unsafe-inline' and eval, so the module must use neither.
    expect(module).not.toContain("innerHTML");
    expect(module).not.toMatch(/\beval\(|new Function\(/);
  });

  it("sends a strict CSP and no CORS header at all", async () => {
    const { origin } = await wizard();
    for (const path of ["/", "/app.js", "/state"]) {
      const response = await request(origin, path);
      expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      for (const header of [...response.headers.keys()]) expect(header.startsWith("access-control-")).toBe(false);
    }
  });

  it("FR-010: refuses every request without this run's session token", async () => {
    const { origin } = await wizard();
    for (const path of ["/", "/app.js", "/app.css", "/state", "/events"]) {
      expect((await fetch(`${origin}${path}`)).status).toBe(401);
      expect((await fetch(`${origin}${path}`, { headers: { [WIZARD_TOKEN_HEADER]: `${TOKEN}x` } })).status).toBe(401);
      expect((await fetch(`${origin}${path}?${WIZARD_TOKEN_QUERY}=nope`)).status).toBe(401);
    }
    const posted = await fetch(`${origin}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(posted.status).toBe(401);
    // The token is equally good in the query string, which is how a page load and an event stream carry it.
    expect((await fetch(`${origin}/state?${WIZARD_TOKEN_QUERY}=${TOKEN}`)).status).toBe(200);
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

  it("refuses a request for another name that resolves to 127.0.0.1", async () => {
    const { server, origin } = await wizard();
    const answered = await new Promise<string>((resolvePromise, reject) => {
      const socket = connect({ host: "127.0.0.1", port: server.port }, () => {
        socket.write(`GET /state?${WIZARD_TOKEN_QUERY}=${TOKEN} HTTP/1.1\r\nHost: wizard.attacker.example\r\nConnection: close\r\n\r\n`);
      });
      let text = "";
      socket.on("data", (chunk) => { text += chunk.toString("utf8"); });
      socket.on("end", () => resolvePromise(text));
      socket.on("error", reject);
    });
    expect(answered).toContain("403");
    expect(answered).toContain("wrong Host");
    expect((await request(origin, "/state")).status).toBe(200);
  });

  it("an answer posted to the page resolves the question the run is waiting on", async () => {
    const { hub, origin } = await wizard();
    const prompter = browserPrompter(hub);
    const answer = prompter.ask("GitHub organization", { flag: "--github-account" });
    const question = hub.state().question;
    expect(question).toBeDefined();
    const reply = (await (await postAnswer(origin, { id: question?.id, value: "acme" })).json()) as AnswerReply;
    expect(reply).toEqual({ ok: true });
    await expect(answer).resolves.toBe("acme");
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

  it("streams the snapshot, then every state change and log line, then the close", async () => {
    const { hub, server, origin } = await wizard();
    hub.setSteps([{ id: "prerequisites", title: "Check your AWS account" }]);
    hub.log("fetching the release");
    const stream = await request(origin, "/events");
    expect(stream.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    const until = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`the stream ended before ${needle}: ${text}`);
        text += decoder.decode(value, { stream: true });
      }
    };
    await until("event: snapshot");
    expect(text).toContain('"log":["fetching the release"]');
    hub.log("==> Check your AWS account");
    await until("event: log");
    expect(text).toContain('data: "==> Check your AWS account"');
    hub.applyEvent({ kind: "step-started", id: "prerequisites", title: "Check your AWS account" });
    await until("event: state");
    expect(text).toContain('"status":"running"');
    hub.close();
    await until("event: closed");
    await server.close();
  });

  it("stops listening when the run closes it", async () => {
    const { hub, server, origin } = await wizard();
    hub.close();
    await server.close();
    await expect(request(origin, "/state")).rejects.toThrow();
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
