// tests/contract/init-ui-github.test.ts
// FR-030 (Q6): the GitHub App's manifest form and GitHub's redirect back are served by the
// wizard's own address. The redirect is the one request that may arrive from another site without
// the session token, so it is held to the manifest flow's own state, once, while a GitHub App is
// awaited, and to the listener's own Host.
import { afterEach, describe, expect, it } from "vitest";
import { WIZARD_TOKEN_HEADER } from "../../packages/cli/src/init/ui/protocol.js";
import { GITHUB_CALLBACK_PATH, manifestFormCsp, startWizardServer, type WizardServer } from "../../packages/cli/src/init/ui/server.js";
import { createWizardHub } from "../../packages/cli/src/init/ui/state.js";
import { githubAppManifest, manifestFormPage } from "../../packages/cli/src/init/github-app.js";

const TOKEN = "test-session-token-bbbbbbbbbbbbbbbbbbb";
const STATE = "0123456789abcdef0123456789abcdef";
const open: WizardServer[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((server) => server.close())); });

async function wizard() {
  const server = await startWizardServer({ hub: createWizardHub("staging"), token: TOKEN });
  open.push(server);
  return { server, origin: `http://127.0.0.1:${server.port}` };
}
const page = (redirectUrl: string, nonce?: string) => manifestFormPage({ actionUrl: `https://github.com/settings/apps/new?state=${STATE}`, manifest: githubAppManifest({ appName: "AgentX", redirectUrl }), ...(nonce === undefined ? {} : { nonce }) });
const fromGitHub = { "sec-fetch-site": "cross-site", referer: "https://github.com/" };
const settled = <T>(promise: Promise<T>) => Promise.race([promise.then(() => "resolved", () => "rejected"), new Promise((resolve) => setTimeout(() => resolve("pending"), 50))]);

describe("the GitHub App flow on the wizard's own address", () => {
  it("serves the form page with the session token only, under a CSP that lets its one script post to GitHub", async () => {
    const { server, origin } = await wizard();
    const mount = server.mountManifest({ state: STATE, page, timeoutMs: 60_000 });
    expect(mount.redirectUrl).toBe(`${origin}${GITHUB_CALLBACK_PATH}`);
    expect(mount.startUrl).toBe(`${origin}/github/start?t=${TOKEN}`);
    expect((await fetch(`${origin}/github/start`)).status).toBe(401);
    const response = await fetch(mount.startUrl);
    expect(response.status).toBe(200);
    const csp = response.headers.get("content-security-policy") ?? "";
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1] ?? "";
    expect(csp).toBe(manifestFormCsp(nonce));
    expect(csp).toContain("form-action https://github.com");
    const html = await response.text();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain(`action="https://github.com/settings/apps/new?state=${STATE}"`);
    // The manifest names the wizard's own callback (its JSON is HTML-escaped, which leaves the address as it is).
    expect(html).toContain(mount.redirectUrl);
    mount.close();
  });

  it("takes GitHub's cross-site redirect with the right state, once, and resolves the code", async () => {
    const { server, origin } = await wizard();
    const mount = server.mountManifest({ state: STATE, page, timeoutMs: 60_000 });
    const answer = await fetch(`${origin}${GITHUB_CALLBACK_PATH}?code=0123456789abcdef0123&state=${STATE}`, { headers: fromGitHub });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("referrer-policy")).toBe("no-referrer");
    expect(answer.headers.get("access-control-allow-origin")).toBeNull();
    expect(await answer.text()).toContain("Go back to the Install AgentX tab to continue.");
    await expect(mount.code).resolves.toBe("0123456789abcdef0123");
    // Review Focus 2: a second callback (a second GitHub tab) is refused like any other request:
    // with GitHub's cross-site headers that is the ordinary cross-site refusal, checked before the token.
    const second = await fetch(`${origin}${GITHUB_CALLBACK_PATH}?code=fedcba9876543210fedc&state=${STATE}`, { headers: fromGitHub });
    expect(second.status).toBe(403);
    expect(await second.text()).toBe("cross-site request\n");
  });

  it("refuses a callback with another run's state, and keeps waiting for the right one", async () => {
    const { server, origin } = await wizard();
    const mount = server.mountManifest({ state: STATE, page, timeoutMs: 60_000 });
    const wrong = await fetch(`${origin}${GITHUB_CALLBACK_PATH}?code=0123456789abcdef0123&state=ffffffffffffffffffffffffffffffff`, { headers: fromGitHub });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain("This page is from a different agentx init run.");
    expect(await settled(mount.code)).toBe("pending");
    expect((await fetch(`${origin}${GITHUB_CALLBACK_PATH}?state=${STATE}`, { headers: fromGitHub })).status).toBe(400);
    expect(await settled(mount.code)).toBe("pending");
    mount.close();
  });

  it("refuses a callback that names another Host, even with the right state", async () => {
    const { server } = await wizard();
    const mount = server.mountManifest({ state: STATE, page, timeoutMs: 60_000 });
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve) => {
      request({ host: "127.0.0.1", port: server.port, path: `${GITHUB_CALLBACK_PATH}?code=0123456789abcdef0123&state=${STATE}`, headers: { host: `localhost:${server.port}` } }, (response) => { response.resume(); resolve(response.statusCode ?? 0); }).end();
    });
    expect(status).toBe(403);
    expect(await settled(mount.code)).toBe("pending");
    mount.close();
  });

  it("Review Focus 1: a callback after the wait ended is refused like any other request", async () => {
    const { server, origin } = await wizard();
    const mount = server.mountManifest({ state: STATE, page, timeoutMs: 20 });
    await expect(mount.code).rejects.toThrow("no GitHub App was created within 0 minutes; run agentx init again");
    const late = await fetch(`${origin}${GITHUB_CALLBACK_PATH}?code=0123456789abcdef0123&state=${STATE}`, { headers: fromGitHub });
    expect(late.status).toBe(403);
    expect(await late.text()).toBe("cross-site request\n");
    // Without GitHub's headers it is the token refusal, like any other request.
    expect((await fetch(`${origin}${GITHUB_CALLBACK_PATH}?code=0123456789abcdef0123&state=${STATE}`)).status).toBe(401);
    // Without a mount the start page is not there either.
    expect((await fetch(`${origin}/github/start`, { headers: { [WIZARD_TOKEN_HEADER]: TOKEN } })).status).toBe(404);
  });

  it("rejects the wait when the wizard closes", async () => {
    const { server } = await wizard();
    const mount = server.mountManifest({ state: STATE, page, timeoutMs: 60_000 });
    await server.close();
    open.splice(0);
    await expect(mount.code).rejects.toThrow("the install wizard closed before the GitHub App was created");
  });
});
