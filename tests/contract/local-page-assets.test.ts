// Every asset a local page links to has to load the way a browser would ask for it: same-origin,
// with the page as its Referer and no session-token header. The install and workspaces pages once
// linked their stylesheets without the token, so the server refused them with 401 and neither page
// was ever styled (issue #234).
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startWizardServer } from "../../packages/cli/src/init/ui/server.js";
import { WIZARD_TOKEN_QUERY } from "../../packages/cli/src/init/ui/protocol.js";
import { createWizardHub } from "../../packages/cli/src/init/ui/state.js";
import { startWorkspacesUiServer } from "../../packages/cli/src/workspaces-ui/server.js";
import { UI_TOKEN_QUERY } from "../../packages/cli/src/workspaces-ui/protocol.js";

const TOKEN = "test-session-token-aaaaaaaaaaaaaaaaaaa";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

interface Reply { status: number; type: string | undefined; body: string }

/** A plain GET with exactly the headers given, nothing added (fetch would add its own). */
function get(origin: string, path: string, headers: Record<string, string>): Promise<Reply> {
  return new Promise((resolvePromise, reject) => {
    const target = new URL(path, origin);
    const req = httpRequest({ host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: "GET", headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolvePromise({ status: response.statusCode ?? 0, type: response.headers["content-type"], body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Every same-origin URL the page loads from a `<link href>` or `<script src>`. */
function assetUrls(html: string): Array<{ tag: "link" | "script"; url: string }> {
  const found: Array<{ tag: "link" | "script"; url: string }> = [];
  for (const match of html.matchAll(/<(link|script)\b[^>]*?\s(?:href|src)="([^"]+)"/g)) {
    const [, tag, raw] = match;
    if (tag === undefined || raw === undefined) continue;
    const url = raw.replaceAll("&amp;", "&");
    if (url.startsWith("/") && !url.startsWith("//")) found.push({ tag: tag as "link" | "script", url });
  }
  return found;
}

const EXPECTED_TYPE = { link: "text/css; charset=utf-8", script: "text/javascript; charset=utf-8" } as const;

async function checkAssets(origin: string, pagePath: string): Promise<void> {
  const host = new URL(origin).host;
  const page = await get(origin, pagePath, { host, "sec-fetch-site": "none" });
  expect(page.status).toBe(200);
  const assets = assetUrls(page.body);
  expect(assets.map((asset) => asset.tag).sort()).toEqual(["link", "script"]);
  for (const asset of assets) {
    // What a browser sends for a subresource of the page: same-origin, the page as Referer
    // (the page sets `referrer` to `same-origin`, so the full URL), and no token header.
    const reply = await get(origin, asset.url, { host, "sec-fetch-site": "same-origin", referer: `${origin}${pagePath}` });
    expect({ url: asset.url, status: reply.status, type: reply.type }).toEqual({ url: asset.url, status: 200, type: EXPECTED_TYPE[asset.tag] });
  }
}

describe("local pages load every asset they link to", () => {
  it("the install page's stylesheet and module answer 200 to a browser's request", async () => {
    const server = await startWizardServer({ hub: createWizardHub("staging"), token: TOKEN });
    closers.push(() => server.close());
    await checkAssets(`http://127.0.0.1:${server.port}`, `/?${WIZARD_TOKEN_QUERY}=${TOKEN}`);
  });

  it("the workspaces page's stylesheet and module answer 200 to a browser's request", async () => {
    const server = await startWorkspacesUiServer({ read: async () => { throw new Error("not read"); }, token: TOKEN });
    closers.push(() => server.close());
    await checkAssets(`http://127.0.0.1:${server.port}`, `/?${UI_TOKEN_QUERY}=${TOKEN}`);
  });
});
